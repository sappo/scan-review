const { test, expect } = require('@playwright/test');
const reset = require('./reset-queue');

// Every test starts from the same queue. Without this the second project finds
// an empty queue - the first one consumed it - and tests depend on run order.
test.beforeEach(() => reset());

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

const fs = require('fs');
const path = require('path');
const TRUTH = path.join(__dirname, '..', 'groundtruth');

test('accepting an untouched frame records schema 2 with unchanged=true',
  async ({ request }) => {
    const { pending } = await (await request.get('/api/queue')).json();
    const p = pending.find(x => x.seeded);
    const r = await request.post(`/api/accept/${encodeURIComponent(p.id)}`, {
      data: { corners: p.corners, frame: p.seeded, rotation: 0,
              target: p.seeded.format } });
    expect(r.ok()).toBeTruthy();

    const rec = JSON.parse(fs.readFileSync(path.join(TRUTH, p.id + '.json'), 'utf8'));
    expect(rec.schema).toBe(2);
    expect(rec.seeded).toBeTruthy();
    expect(rec.detected).toBeTruthy();
    expect(rec.error.unchanged).toBe(true);
    expect(rec.error.centre_dist_px).toBeCloseTo(0, 6);
    expect(rec).not.toHaveProperty('corner_shift_px');
  });

// ---------------------------------------------------------------- UI tests

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.state && window.state.img);
}
async function frameOf(page) { return page.evaluate(() => ({ ...window.state.frame })); }

test('the frame renders axis-aligned while the scan tilts under it', async ({ page }) => {
  await ready(page);
  const rect = await page.evaluate(() => {
    window.state.frame = { cx: 800, cy: 700, w: 400, h: 565.7, angle: -7.679 };
    window.render();
    return window.frameRectOnScreen();
  });
  expect(rect.h / rect.w).toBeCloseTo(565.7 / 400, 4);
  expect(rect.w).toBeGreaterThan(0);
});

test('a drag inside the frame core moves it without resizing', async ({ page }) => {
  await ready(page);
  const before = await frameOf(page);
  const box = await page.getByTestId('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 25, { steps: 8 }); await page.mouse.up();
  const after = await frameOf(page);
  expect(after.w).toBeCloseTo(before.w, 6);
  expect(after.h).toBeCloseTo(before.h, 6);
  expect(after.angle).toBeCloseTo(before.angle, 6);
  expect(Math.hypot(after.cx - before.cx, after.cy - before.cy)).toBeGreaterThan(1);
});

test('resizing from a corner holds the ratio and anchors the opposite corner',
  async ({ page }) => {
    await ready(page);
    const want = await page.evaluate(() => window.state.frame.h / window.state.frame.w);
    const wBefore = await page.evaluate(() => window.state.frame.w);
    const anchorBefore = await page.evaluate(() => window.cornersOf(window.state.frame)[2]);
    const r = await page.evaluate(() => {
      const q = window.frameRectOnScreen();
      const b = document.getElementById('cv').getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return { x: b.x + q.x / dpr, y: b.y + q.y / dpr };
    });
    await page.mouse.move(r.x, r.y); await page.mouse.down();
    await page.mouse.move(r.x + 60, r.y + 60, { steps: 10 }); await page.mouse.up();
    const f = await frameOf(page);
    expect(f.h / f.w).toBeCloseTo(want, 9);                   // ratio held
    const anchorAfter = await page.evaluate(() => window.cornersOf(window.state.frame)[2]);
    expect(anchorAfter[0]).toBeCloseTo(anchorBefore[0], 3);   // BR pinned
    expect(anchorAfter[1]).toBeCloseTo(anchorBefore[1], 3);
    expect(f.w).toBeLessThan(wBefore);
  });

test('a drag starting outside the frame changes nothing', async ({ page }) => {
  await ready(page);
  const before = await frameOf(page);
  const box = await page.getByTestId('canvas').boundingBox();
  await page.mouse.move(box.x + 3, box.y + 3); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 90, { steps: 8 }); await page.mouse.up();
  expect(await frameOf(page)).toEqual(before);
});

test('the grab band never swallows the whole frame', async ({ page }) => {
  await ready(page);
  const ok = await page.evaluate(() => {
    window.state.view.zoom = 1;
    window.state.frame.w = 40; window.state.frame.h = 56.6;
    window.render();
    const r = window.frameRectOnScreen();
    return window.bandWidth() * 2 < Math.min(r.w, r.h);
  });
  expect(ok).toBe(true);
});

test('zoom is clamped and never alters the frame', async ({ page }) => {
  await ready(page);
  const before = await frameOf(page);
  const z = await page.evaluate(() => {
    window.setZoom(99, [100, 100]);
    const hi = window.state.view.zoom;
    window.setZoom(0.01, [100, 100]);
    return { hi, lo: window.state.view.zoom };
  });
  expect(z.hi).toBe(8);
  expect(z.lo).toBe(1);
  expect(await frameOf(page)).toEqual(before);
});

test('the dial reads zero at the detected angle and applies a delta', async ({ page }) => {
  await ready(page);
  const det = await page.evaluate(() => window.state.detectedAngle);
  expect(await page.evaluate(() => window.dialValue())).toBeCloseTo(0, 6);
  await page.evaluate(() => window.setDial(2.5));
  expect(await page.evaluate(() => window.state.frame.angle)).toBeCloseTo(det + 2.5, 6);
  expect(await page.getByTestId('angle-readout').textContent()).toContain('2.5');
});

test('the dial holds the ratio and is one undo step', async ({ page }) => {
  await ready(page);
  const want = await page.evaluate(() => window.state.frame.h / window.state.frame.w);
  const before = await frameOf(page);
  await page.getByTestId('mode-straighten').click();
  const box = await page.getByTestId('dial').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  const f = await frameOf(page);
  expect(f.h / f.w).toBeCloseTo(want, 9);
  expect(Math.abs(f.angle - before.angle)).toBeGreaterThan(0.2);
  await page.getByTestId('btn-undo').click();
  expect(await page.evaluate(() => window.state.frame.angle)).toBeCloseTo(before.angle, 6);
});

test('nudge buttons step the dial by a tenth of a degree', async ({ page }) => {
  await ready(page);
  await page.getByTestId('mode-straighten').click();
  await page.getByTestId('skew-plus-01').click();
  expect(await page.evaluate(() => window.dialValue())).toBeCloseTo(0.1, 6);
  await page.getByTestId('skew-minus-01').click();
  await page.getByTestId('skew-minus-01').click();
  expect(await page.evaluate(() => window.dialValue())).toBeCloseTo(-0.1, 6);
});

/** Count PAINTED pixels on the raster overlay. The overlay starts fully
 *  transparent, so "grid off" really is exactly zero - an assertion that would
 *  be impossible if the grid were drawn over the scan itself. */
async function paintedIn(page, channel) {
  return page.evaluate((ch) => {
    const g = document.getElementById('grid');
    const d = g.getContext('2d').getImageData(0, 0, g.width, g.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      if (ch === 'any') n++;
      else if (ch === 'blue' && d[i + 2] > d[i] + 40) n++;
      else if (ch === 'red' && d[i] > d[i + 2] + 60) n++;
    }
    return n;
  }, channel);
}

test('the raster paints blue gridlines and a red centre cross, and toggles off',
  async ({ page }) => {
    await ready(page);
    expect(await paintedIn(page, 'blue')).toBeGreaterThan(100);
    expect(await paintedIn(page, 'red')).toBeGreaterThan(50);
    await page.getByTestId('grid-toggle').click();
    expect(await paintedIn(page, 'any')).toBe(0);
  });

test('changing format re-locks the ratio about the same centre', async ({ page }) => {
  await ready(page);
  const before = await frameOf(page);
  await page.getByTestId('fmt-A6').click();
  const f = await frameOf(page);
  const want = await page.evaluate(() =>
    window.state.orientation === 'landscape' ? 105 / 148 : 148 / 105);
  expect(f.h / f.w).toBeCloseTo(want, 9);
  expect(f.cx).toBeCloseTo(before.cx, 6);
  expect(f.cy).toBeCloseTo(before.cy, 6);
  await expect(page.getByTestId('fmt-A6')).toHaveAttribute('aria-pressed', 'true');
});

test('swapping orientation transposes the frame', async ({ page }) => {
  await ready(page);
  const before = await frameOf(page);
  await page.getByTestId('btn-swap').click();
  const f = await frameOf(page);
  expect(f.w).toBeCloseTo(before.h, 6);
  expect(f.h).toBeCloseTo(before.w, 6);
});

test('rotate cycles output rotation without moving the frame', async ({ page }) => {
  await ready(page);
  const before = await frameOf(page);
  await page.getByTestId('btn-rotate').click();
  expect(await page.evaluate(() => window.state.rotation)).toBe(90);
  expect(await frameOf(page)).toEqual(before);
});

test('reset returns to the seeded frame after several edits', async ({ page }) => {
  await ready(page);
  const seeded = await page.evaluate(() => ({ ...window.state.page.seeded }));
  await page.getByTestId('fmt-A6').click();
  await page.evaluate(() => window.setDial(3));
  await page.getByTestId('btn-reset').click();
  const f = await frameOf(page);
  expect(f.cx).toBeCloseTo(seeded.cx, 4);
  expect(f.w).toBeCloseTo(seeded.w, 4);
  expect(f.angle).toBeCloseTo(seeded.angle, 6);
});

test('A4 accepts at exactly the ISO size however the frame was dragged',
  async ({ page, request }) => {
    await ready(page);
    const id = await page.evaluate(() => window.state.page.id);
    const out = await page.evaluate(async () => {
      window.setFormat('A4');
      window.state.frame.w *= 0.72;               // a big, deliberate distortion
      window.state.frame.h = window.state.frame.w * (297 / 210);
      window.render();
      const r = await fetch('/api/accept/' + encodeURIComponent(window.state.page.id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ corners: window.cornersOf(window.state.frame),
                               frame: { ...window.state.frame, format: 'A4',
                                        orientation: 'portrait' },
                               rotation: 0, target: 'A4' }) });
      return r.json();
    });
    expect(out.width).toBe(1654);
    expect(out.height).toBe(2339);
    const rec = JSON.parse(fs.readFileSync(path.join(TRUTH, id + '.json'), 'utf8'));
    expect(rec.accepted.format).toBe('A4');
    expect(rec.error.unchanged).toBe(false);      // it was deliberately distorted
    const { pending } = await (await request.get('/api/queue')).json();
    expect(pending.find(p => p.id === id)).toBeUndefined();
  });

test('A6 accepts at exactly 1165x827 landscape', async ({ page }) => {
  await ready(page);
  const out = await page.evaluate(async () => {
    window.setFormat('A6');
    if (window.state.orientation !== 'landscape') window.swapOrientation();
    const r = await fetch('/api/accept/' + encodeURIComponent(window.state.page.id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ corners: window.cornersOf(window.state.frame),
                             frame: { ...window.state.frame,
                                      format: 'A6', orientation: 'landscape' },
                             rotation: 0, target: 'A6' }) });
    return r.json();
  });
  expect(out.width).toBe(1165);
  expect(out.height).toBe(827);
});

test('pushing the frame past the scan edge warns but still accepts', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { window.state.frame.cy -= window.state.frame.h * 0.6;
                              window.render(); });
  await expect(page.getByTestId('outside-flag')).toBeVisible();
  await page.getByTestId('btn-accept').click();
  await expect(page.getByTestId('status')).toContainText('accepted');
});

test('finalize delivers a PDF to the paperless mock', async ({ page }) => {
  await ready(page);
  await page.getByTestId('btn-accept').click();
  await expect(page.getByTestId('status')).toContainText('accepted');
  await page.getByTestId('btn-finalize').click();
  await expect(page.getByTestId('status')).toContainText('paperless');
  const { execSync } = require('child_process');
  const consume = path.join(__dirname, '..', 'mock-paperless', 'consume');
  const pdfs = fs.readdirSync(consume).filter(f => f.endsWith('.pdf')).sort();
  expect(pdfs.length).toBeGreaterThan(0);
  const n = execSync(`qpdf --show-npages ${path.join(consume, pdfs[pdfs.length - 1])}`)
    .toString().trim();
  expect(Number(n)).toBeGreaterThan(0);
});
