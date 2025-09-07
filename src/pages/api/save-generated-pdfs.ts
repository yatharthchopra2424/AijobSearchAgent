import type { NextApiRequest, NextApiResponse } from 'next';
import admin from 'firebase-admin';
import puppeteer from 'puppeteer-core';
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
  console.log('📂 Current working directory:', process.cwd());
  console.log('🔧 __dirname:', __dirname);

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
    console.log('[save-generated-pdfs] Launching browser...');

    const cacheDir = path.join(process.cwd(), '.cache', 'puppeteer');

    // Ensure cache directory exists
    if (!fs.existsSync(cacheDir)) {
      console.log(`[save-generated-pdfs] Cache directory doesn't exist, creating: ${cacheDir}`);
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
      } catch (mkdirErr) {
        console.error(`[save-generated-pdfs] Failed to create cache directory: ${mkdirErr}`);
      }
    }

    let executablePath: string | undefined;
    if (fs.existsSync(cacheDir)) {
      console.log(`[save-generated-pdfs] Cache directory exists: ${cacheDir}`);
      const dirs = fs.readdirSync(cacheDir);
      console.log(`[save-generated-pdfs] Cache directory contents:`, dirs);

      // Look for Linux Chrome first (for Vercel deployment)
      const linuxDir = dirs.find(dir => dir.startsWith('linux-'));
      if (linuxDir) {
        const chromePath = path.join(cacheDir, linuxDir, 'chrome-linux64', 'chrome');
        if (fs.existsSync(chromePath)) {
          executablePath = chromePath;
          console.log(`[save-generated-pdfs] Found Linux Chrome at: ${chromePath}`);
        }
      }
      // Fallback to Windows Chrome
      if (!executablePath) {
        const winDir = dirs.find(dir => dir.startsWith('win64-'));
        if (winDir) {
          const chromePath = path.join(cacheDir, winDir, 'chrome-win64', 'chrome.exe');
          if (fs.existsSync(chromePath)) {
            executablePath = chromePath;
            console.log(`[save-generated-pdfs] Found Windows Chrome at: ${chromePath}`);
          }
        }
      }
    } else {
      console.error(`[save-generated-pdfs] Cache directory does not exist: ${cacheDir}`);
      console.log(`[save-generated-pdfs] Attempting to list root directory contents...`);
      try {
        const rootContents = fs.readdirSync(process.cwd());
        console.log(`[save-generated-pdfs] Root directory contents:`, rootContents);
      } catch (listErr) {
        console.error(`[save-generated-pdfs] Failed to list root directory: ${listErr}`);
      }
    }

    // Additional fallback: try to find any Chrome executable in the cache
    if (!executablePath) {
      console.log('[save-generated-pdfs] No Chrome found with standard paths, searching recursively...');
      const findChrome = (dir: string): string | undefined => {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            const result = findChrome(fullPath);
            if (result) return result;
          } else if (item === 'chrome' || item === 'chrome.exe') {
            return fullPath;
          }
        }
        return undefined;
      };
      executablePath = findChrome(cacheDir);
      if (executablePath) {
        console.log(`[save-generated-pdfs] Found Chrome via recursive search: ${executablePath}`);
      }
    }

    if (!executablePath) {
      throw new Error('Chrome executable not found in cache. Run "npx puppeteer browsers install chrome" first.');
    }

    console.log(`[save-generated-pdfs] Using executable: ${executablePath}`);

    // Verify the executable exists and is executable
    if (executablePath) {
      try {
        const stats = fs.statSync(executablePath);
        console.log(`[save-generated-pdfs] Chrome executable stats: size=${stats.size}, mode=${stats.mode.toString(8)}`);

        // Check if executable bit is set, if not, try to set it
        if (!(stats.mode & parseInt('111', 8))) {
          console.log(`[save-generated-pdfs] Chrome executable doesn't have execute permissions, attempting to set...`);
          try {
            // Try to set execute permissions (this might not work in all environments)
            fs.chmodSync(executablePath, 0o755);
            console.log(`[save-generated-pdfs] Successfully set execute permissions on Chrome binary`);
          } catch (chmodErr) {
            console.warn(`[save-generated-pdfs] Failed to set execute permissions: ${chmodErr}`);
            // Continue anyway, as some environments might handle this automatically
          }
        }

        // Also check and set permissions for related Chrome binaries
        const chromeDir = path.dirname(executablePath);
        const relatedBinaries = ['chrome-wrapper', 'chrome-sandbox', 'chrome_crashpad_handler'];
        for (const binary of relatedBinaries) {
          const binaryPath = path.join(chromeDir, binary);
          if (fs.existsSync(binaryPath)) {
            try {
              const binaryStats = fs.statSync(binaryPath);
              if (!(binaryStats.mode & parseInt('111', 8))) {
                fs.chmodSync(binaryPath, 0o755);
                console.log(`[save-generated-pdfs] Set execute permissions on ${binary}`);
              }
            } catch (binaryErr) {
              console.warn(`[save-generated-pdfs] Failed to set permissions on ${binary}: ${binaryErr}`);
            }
          }
        }
      } catch (statErr) {
        console.error(`[save-generated-pdfs] Error checking Chrome executable: ${statErr}`);
        // Don't throw error here, try to continue with puppeteer launch
        console.log(`[save-generated-pdfs] Continuing despite stat error...`);
      }
    }

    // Try cached Chrome first (required for puppeteer-core)
    console.log(`[save-generated-pdfs] Attempting to launch browser with cached Chrome (puppeteer-core)`);

    let browser;
    if (executablePath) {
      try {
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
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--disable-backgrounding-occluded-windows',
            '--disable-field-trial-config',
            '--disable-back-forward-cache',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--force-color-profile=srgb',
            '--metrics-recording-only',
            '--no-crash-upload',
            '--disable-component-extensions-with-background-pages',
            '--disable-extensions',
            '--disable-plugins',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-first-run',
            '--safebrowsing-disable-auto-update',
            '--single-process',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor'
          ],
        });
        console.log(`[save-generated-pdfs] Browser launched successfully with cached Chrome`);
      } catch (launchErr) {
        console.error(`[save-generated-pdfs] Failed to launch with cached Chrome: ${launchErr}`);
        throw new Error(`Failed to launch browser: ${launchErr}`);
      }
    } else {
      console.error(`[save-generated-pdfs] No Chrome executable found in cache`);
      throw new Error('Chrome executable not found in cache. Run "npx puppeteer browsers install chrome" first.');
    }
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
      return res.status(500).json({ error: (pdfErr as Error)?.message || 'Failed to generate or upload PDFs' });
    }
  } catch (error: unknown) {
    console.error('❌ [save-generated-pdfs] Critical Error:', error);
    if (!res.headersSent) {
      const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
      return res.status(500).json({ error: errorMessage });
    }
    return;
  }
}