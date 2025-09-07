const { join } = require('path');

/**
 * @type {import("puppeteer-core").Configuration}
 */
module.exports = {
  // Configure Puppeteer cache directory
  cacheDirectory: join(process.cwd(), '.cache', 'puppeteer'),
  // Skip download since we manage Chrome binaries manually for puppeteer-core
  skipDownload: true,
  // Let our API code handle executable path resolution
  executablePath: undefined,
};
