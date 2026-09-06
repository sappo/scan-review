const { devices } = require('@playwright/test');

// No credentials. In a packaged install SSOwat authenticates the operator
// before the request reaches uvicorn, so there is nothing for a browser to
// send; the suite drives the app directly on its loopback port, which is where
// SSOwat would have delivered the request anyway. The dev service runs with
// SCANPIPE_ALLOW_ANONYMOUS=1 for the same reason.
//
// The auth model itself is covered by tests/test_auth_modes.py, which exercises
// the middleware stack directly rather than needing a browser to hold a session.
const base = { headless: true, baseURL: 'http://127.0.0.1:8765' };

module.exports = {
  testDir: './tests',
  // Tests accept and reject pages, which consumes the queue. Without this the
  // suite passes once and then fails for want of pending pages.
  globalSetup: require.resolve('./tests/reset-queue.js'),
  // The suite shares the live queue with real scans, so it takes its own
  // documents back out when it finishes.
  globalTeardown: require.resolve('./tests/teardown-queue.js'),
  // One worker, always. The tests share one single-process server and one
  // state.json; parallel workers race each other's queue resets. This is the
  // same constraint that forbids `uvicorn --workers N`.
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: base,
  projects: [
    // Review happens mostly on a phone, so that is the primary project.
    { name: 'mobile', use: { ...base, ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...base, viewport: { width: 1280, height: 1000 } } },
  ],
  reporter: [['list']],
};
