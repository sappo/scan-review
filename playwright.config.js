const { devices } = require('@playwright/test');

// The service requires basic auth; read it from the same file systemd uses.
const httpCredentials = (() => {
  const fs = require('fs');
  const env = Object.fromEntries(
    fs.readFileSync(__dirname + '/secrets.env', 'utf8')
      .split('\n').filter(Boolean).map(l => l.split('=')));
  return { username: env.SCANPIPE_USER, password: env.SCANPIPE_PASS };
})();

const base = { headless: true, baseURL: 'http://127.0.0.1:8765', httpCredentials };

module.exports = {
  testDir: './tests',
  // Tests accept and reject pages, which consumes the queue. Without this the
  // suite passes once and then fails for want of pending pages.
  globalSetup: require.resolve('./tests/reset-queue.js'),
  timeout: 30000,
  use: base,
  projects: [
    // Review happens mostly on a phone, so that is the primary project.
    { name: 'mobile', use: { ...base, ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...base, viewport: { width: 1280, height: 1000 } } },
  ],
  reporter: [['list']],
};
