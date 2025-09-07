const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Configure Puppeteer cache directory
  cacheDirectory: './.cache/puppeteer',
};
