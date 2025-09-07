const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Configure Puppeteer cache directory
  cacheDirectory: join(process.cwd(), '.cache', 'puppeteer'),
  // Allow Puppeteer to download its bundled Chromium
  skipDownload: false,
  // Let Puppeteer use its bundled Chromium automatically
  executablePath: undefined,
};
