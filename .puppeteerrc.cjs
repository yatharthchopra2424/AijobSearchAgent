const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Configure Puppeteer cache directory
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
  // Skip download since we manage Chrome binaries manually
  skipDownload: true,
};
