import type { NextApiRequest, NextApiResponse } from 'next';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';


/**
 * save-generated-pdfs API - optimized for Vercel serverless
 *
 * Behavior:
 * - Uses full puppeteer with bundled Chromium for consistent behavior
 * - Same configuration for both development and production
 * - Lazy Firebase Admin init.
 * - Generates PDFs from HTML content
 */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log('\n--- 📩 Incoming request to /api/save-generated-pdfs ---');
  console.log('➡️ Method:', req.method);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST requests are allowed' });
  }

  const { userId, jobApplicationId, resumeHtml, coverLetterHtml } = req.body || {};

  console.log('📦 Request body:', {
    jobApplicationId,
    resumeHtmlSnippet: typeof resumeHtml === 'string' ? resumeHtml.slice(0, 100) : undefined,
    coverLetterHtmlSnippet: typeof coverLetterHtml === 'string' ? coverLetterHtml.slice(0, 100) : undefined,
  });

  if (!jobApplicationId || !resumeHtml || !coverLetterHtml) {
    console.warn('❌ Missing required fields!');
    return res.status(400).json({ error: 'Missing jobApplicationId, resumeHtml, or coverLetterHtml' });
  }

  try {
    // Firebase Admin lazy init
    if (!admin.apps.length) {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
      const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;

      if (!projectId || !clientEmail || !privateKeyRaw || !storageBucket) {
        console.error('[save-generated-pdfs] Missing Firebase environment variables');
        return res.status(500).json({ error: 'Server configuration error: missing Firebase credentials' });
      }

      try {
        const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey,
          }),
          storageBucket,
        });
        console.log('[✅] Firebase Admin initialized');
      } catch (initErr) {
        console.error('[❌] Firebase initialization failed:', initErr);
        return res.status(500).json({ error: 'Failed to initialize Firebase Admin' });
      }
    }

    const db = admin.firestore();
    const bucket = admin.storage().bucket();

    // Launch browser with consistent configuration
    let browser;

    // Launch browser with cached Chrome, prefer linux then windows fallback
    console.log('[save-generated-pdfs] Launching browser...');

    const cacheDir = './.cache/puppeteer';

    let executablePath: string | undefined;
    if (fs.existsSync(cacheDir)) {
      const dirs = fs.readdirSync(cacheDir);
      // Look for Linux Chrome first (for Vercel deployment)
      const linuxDir = dirs.find(dir => dir.startsWith('linux-'));
      if (linuxDir) {
        const chromePath = path.join(cacheDir, linuxDir, 'chrome-linux64', 'chrome');
        if (fs.existsSync(chromePath)) {
          executablePath = chromePath;
        }
      }
      // Fallback to Windows Chrome
      if (!executablePath) {
        const winDir = dirs.find(dir => dir.startsWith('win64-'));
        if (winDir) {
          const chromePath = path.join(cacheDir, winDir, 'chrome-win64', 'chrome.exe');
          if (fs.existsSync(chromePath)) {
            executablePath = chromePath;
          }
        }
      }
    }

    if (!executablePath) {
      throw new Error('Chrome executable not found in cache. Run "npx puppeteer browsers install chrome" first.');
    }

    console.log(`[save-generated-pdfs] Using executable: ${executablePath}`);

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu'
      ],
    });
    console.log('[save-generated-pdfs] Browser launched successfully');

    // Helper to make a PDF with a fresh page
    const makePdf = async (html: string) => {
      const page = await browser.newPage();
      try {
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
        // allow fonts/assets to settle
        await new Promise((r) => setTimeout(r, 300));
        const buffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
          preferCSSPageSize: false,
          scale: 1,
          timeout: 60000,
        });
        return buffer;
      } finally {
        try {
          if (page && !page.isClosed()) await page.close();
        } catch (_) {}
      }
    };

    try {
      const resumeBuffer = await makePdf(resumeHtml);
      const coverLetterBuffer = await makePdf(coverLetterHtml);
      console.log('📄 PDFs generated successfully');

      const uploadAndGetUrl = async (buffer: Uint8Array | Buffer, filename: string) => {
        const file = bucket.file(filename);
        const bufferToSave = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        await file.save(bufferToSave, { contentType: 'application/pdf' });
        try {
          await file.makePublic();
          return file.publicUrl();
        } catch (e) {
          console.warn('[save-generated-pdfs] makePublic failed, returning gs:// path', e);
          return `gs://${bucket.name}/${filename}`;
        }
      };

      const resumeFilename = `ApplicationDocuments/${jobApplicationId}_resume.pdf`;
      const coverLetterFilename = `ApplicationDocuments/${jobApplicationId}_coverletter.pdf`;

      console.log('📤 Uploading resume PDF...');
      const resumeUrl = await uploadAndGetUrl(resumeBuffer, resumeFilename);
      console.log('✅ Resume uploaded:', resumeUrl);

      console.log('📤 Uploading cover letter PDF...');
      const coverLetterUrl = await uploadAndGetUrl(coverLetterBuffer, coverLetterFilename);
      console.log('✅ Cover letter uploaded:', coverLetterUrl);

      console.log('📝 Updating Firestore document...');
      await db
        .collection('users')
        .doc(userId)
        .collection('jobApplications')
        .doc(jobApplicationId)
        .update({
          resume_url: resumeUrl,
          cover_letter_url: coverLetterUrl,
        });

      console.log('✅ Firestore update successful');

      try {
        if (browser) await browser.close();
      } catch (_) {}

      return res.status(200).json({
        message: 'PDFs uploaded and Firestore updated',
        resumeUrl,
        coverLetterUrl,
      });
    } catch (pdfErr) {
      console.error('[save-generated-pdfs] PDF generation/upload error:', pdfErr);
      try {
        if (browser) await browser.close();
      } catch (_) {}
      return res.status(500).json({ error: (pdfErr as any)?.message || 'Failed to generate or upload PDFs' });
    }
  } catch (error: any) {
    console.error('❌ [save-generated-pdfs] Critical Error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error?.message || 'Internal Server Error' });
    }
    return;
  }
}