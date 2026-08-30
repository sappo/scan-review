const { test, expect } = require('@playwright/test');

test('queue seeds a ratio-locked frame for every pending page', async ({ request }) => {
  const r = await request.get('/api/queue');
  expect(r.ok()).toBeTruthy();
  const { pending } = await r.json();
  expect(pending.length).toBeGreaterThan(0);
  const RATIO = { A4: 297 / 210, A5: 210 / 148, A6: 148 / 105 };
  for (const p of pending) {
    expect(p.seeded, `page ${p.id} has no seeded frame`).toBeTruthy();
    const { w, h, format, orientation } = p.seeded;
    const want = orientation === 'landscape' ? 1 / RATIO[format] : RATIO[format];
    expect(h / w).toBeCloseTo(want, 9);
  }
});
