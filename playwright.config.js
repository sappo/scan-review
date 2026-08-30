module.exports = {
  testDir: './tests',
  timeout: 30000,
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1:8765',
    viewport: { width: 1280, height: 1000 },
    // The service now requires basic auth; read it from the same file systemd uses.
    httpCredentials: (() => {
      const fs = require('fs');
      const env = Object.fromEntries(
        fs.readFileSync(__dirname + '/secrets.env', 'utf8')
          .split('\n').filter(Boolean).map(l => l.split('=')));
      return { username: env.SCANPIPE_USER, password: env.SCANPIPE_PASS };
    })(),
  },
  reporter: [['list']],
};
