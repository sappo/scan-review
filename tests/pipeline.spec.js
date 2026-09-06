const { test, expect } = require('@playwright/test');
const reset = require('./reset-queue');

// Every test starts from the same queue. Without this the second project finds
// an empty queue - the first one consumed it - and tests depend on run order.
test.beforeEach(() => reset());

/** Only the generated fixtures. Real scans pushed by the Pi can be sitting in
 *  the same queue, and a test that sends or deletes one destroys real data. */
function fixtures(documents) {
  return documents.filter(d => d.batch.startsWith('fx-'));
}

/** Every page of every document in the queue. */
async function allPages(request) {
  const { documents } = await (await request.get('/api/queue')).json();
  return documents.flatMap(d => d.pages);
}

test('the queue is a list of documents, each carrying its pages',
  async ({ request }) => {
    const r = await request.get('/api/queue');
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body).not.toHaveProperty('pending');
    expect(Array.isArray(body.documents)).toBe(true);
    expect(body.documents.length).toBeGreaterThan(1);
    for (const d of body.documents) {
      expect(d.batch).toBeTruthy();
      expect(d.label).toBeTruthy();
      expect(d.pages.length).toBe(d.counts.total);
      expect(d.ready).toBe(d.counts.pending === 0);
      const nos = d.pages.map(p => p.page_no);
      expect(nos).toEqual([...nos].sort((a, b) => a - b));
      expect(new Set(d.pages.map(p => p.batch))).toEqual(new Set([d.batch]));
    }
  });

test('queue seeds a ratio-locked frame for every page', async ({ request }) => {
  // Only pages the detector matched to a paper size get a seeded frame: a
  // `free` page has no ratio to lock to, so `seeded` is null by design. Real
  // scans land in `free` often enough (a skewed or edge-to-edge sheet) that
  // asserting over the whole queue made this pass or fail on whatever happened
  // to be waiting for review, not on the code.
  const pages = (await allPages(request)).filter(p => p.format !== 'free');
  expect(pages.length).toBeGreaterThan(0);
  const RATIO = { A4: 297 / 210, A5: 210 / 148, A6: 148 / 105 };
  for (const p of pages) {
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
    const p = (await allPages(request)).find(x => x.seeded);
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
/** Page size / rotation now live behind their own button. */
async function openPageSetup(page) {
  if (await page.getByTestId('fmt-A4').isHidden())
    await page.getByTestId('btn-pagesetup').click();
}

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
  await page.mouse.move(cx + 60, cy + 45, { steps: 10 }); await page.mouse.up();
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
  await openPageSetup(page);
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
  await openPageSetup(page);
  await page.getByTestId('btn-swap').click();
  const f = await frameOf(page);
  expect(f.w).toBeCloseTo(before.h, 6);
  expect(f.h).toBeCloseTo(before.w, 6);
});

test('rotate cycles output rotation without moving the frame', async ({ page }) => {
  await ready(page);
  const before = await frameOf(page);
  await openPageSetup(page);
  await page.getByTestId('btn-rotate').click();
  expect(await page.evaluate(() => window.state.rotation)).toBe(90);
  expect(await frameOf(page)).toEqual(before);
});

test('rotate visibly turns the view, not just a hidden flag', async ({ page }) => {
  await ready(page);
  const before = await page.evaluate(() => {
    const r = window.frameRectOnScreen(); return { w: r.w, h: r.h };
  });
  await openPageSetup(page);
  await page.getByTestId('btn-rotate').click();
  const after = await page.evaluate(() => {
    const r = window.frameRectOnScreen(); return { w: r.w, h: r.h };
  });
  // At 90 the frame lies on its side on screen: the drawn rect transposes.
  expect(after.w).toBeCloseTo(before.h, 6);
  expect(after.h).toBeCloseTo(before.w, 6);
});

test('a corner still resizes correctly when the view is rotated', async ({ page }) => {
  await ready(page);
  await openPageSetup(page);
  await page.getByTestId('btn-rotate').click();            // view turned 90
  const want = await page.evaluate(() => window.state.frame.h / window.state.frame.w);
  // Screen top-left is the frame's bottom-left when turned 90, so the pinned
  // corner is the frame's top-right (index 1).
  const anchorBefore = await page.evaluate(() => window.cornersOf(window.state.frame)[1]);
  const r = await page.evaluate(() => {
    const q = window.frameRectOnScreen();
    const b = document.getElementById('cv').getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: b.x + q.x / dpr, y: b.y + q.y / dpr };
  });
  await page.mouse.move(r.x, r.y); await page.mouse.down();
  await page.mouse.move(r.x + 50, r.y + 50, { steps: 10 }); await page.mouse.up();
  const f = await frameOf(page);
  expect(f.h / f.w).toBeCloseTo(want, 9);
  const anchorAfter = await page.evaluate(() => window.cornersOf(window.state.frame)[1]);
  expect(anchorAfter[0]).toBeCloseTo(anchorBefore[0], 3);
  expect(anchorAfter[1]).toBeCloseTo(anchorBefore[1], 3);
});

test('a small drag below the threshold does not move the frame', async ({ page }) => {
  await ready(page);
  const before = await frameOf(page);
  const box = await page.getByTestId('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + 5, cy + 4, { steps: 4 }); await page.mouse.up();
  expect(await frameOf(page)).toEqual(before);
});

test('the sides are not draggable - only corners resize', async ({ page }) => {
  await ready(page);
  const hits = await page.evaluate(() => {
    const r = window.frameRectOnScreen();
    return [
      window.hitTest([r.x + r.w / 2, r.y]).kind,            // top edge midpoint
      window.hitTest([r.x + r.w, r.y + r.h / 2]).kind,      // right edge midpoint
      window.hitTest([r.x, r.y + r.h / 2]).kind,            // left edge midpoint
      window.hitTest([r.x, r.y]).kind,                      // a corner, still live
    ];
  });
  expect(hits.slice(0, 3)).not.toContain('edge');
  expect(hits[3]).toBe('corner');
});

test('reset clears the undo history too', async ({ page }) => {
  await ready(page);
  const seeded = await page.evaluate(() => ({ ...window.state.page.seeded }));
  await openPageSetup(page);
  await page.getByTestId('fmt-A6').click();
  await page.evaluate(() => window.setDial(3));
  await page.getByTestId('btn-reset').click();
  expect(await page.evaluate(() => window.state.history.length)).toBe(0);
  // Undo cannot walk back into the discarded edits, because with an empty
  // history there is nothing to undo and the button is disabled.
  await expect(page.getByTestId('btn-undo')).toBeDisabled();
  const f = await frameOf(page);
  expect(f.w).toBeCloseTo(seeded.w, 4);
  expect(f.angle).toBeCloseTo(seeded.angle, 6);
});

test('reset returns to the seeded frame after several edits', async ({ page }) => {
  await ready(page);
  const seeded = await page.evaluate(() => ({ ...window.state.page.seeded }));
  await openPageSetup(page);
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
    // The page does not vanish - the filmstrip shows every page of a
    // document whatever its state - so assert on its status instead.
    const after = (await allPages(request)).find(p => p.id === id);
    expect(after.status).toBe('accepted');
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
  await gotoDoc(page, 'fx-letter');
  // Send needs every page decided: one run is one document.
  const n = await decideAll(page);
  await expect(page.getByTestId('page-count')).toHaveText(String(n));
  await page.getByTestId('btn-finalize').click();
  await expect(page.getByTestId('status')).toContainText('paperless');
  const { execSync } = require('child_process');
  const consume = path.join(__dirname, '..', 'mock-paperless', 'consume');
  const pdfs = fs.readdirSync(consume).filter(f => f.endsWith('.pdf')).sort();
  expect(pdfs.length).toBeGreaterThan(0);
  const npages = execSync(
    `qpdf --show-npages ${path.join(consume, pdfs[pdfs.length - 1])}`)
    .toString().trim();
  expect(Number(npages)).toBe(n);
});

test('every icon reference resolves to a symbol in the sprite', async ({ page, request }) => {
  await ready(page);
  const sprite = await (await request.get('/icons.svg')).text();
  const defined = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]);
  const used = await page.evaluate(() =>
    [...document.querySelectorAll('use')].map(u => u.getAttribute('href')));
  expect(used.length).toBeGreaterThan(8);
  for (const href of used) {
    expect(href, 'icons must come from the vendored sprite, not a CDN')
      .not.toMatch(/^(https?:)?\/\//);
    // Relative, not /icons.svg: a packaged install serves the app under a
    // sub-path that nginx strips, so a leading slash escapes the mount point
    // and 404s against the domain root. This used to assert the leading slash,
    // which was incidental to the anti-CDN property it says it is testing.
    expect(href, 'icons must resolve under the app, not the domain root')
      .toMatch(/^icons\.svg#/);
    // A typo'd id renders an empty button with no error, so assert resolution.
    expect(defined, `unresolved icon ${href}`).toContain(href.split('#')[1]);
  }
});

test('buttons are icon-only, apart from the format chips', async ({ page }) => {
  await ready(page);
  const labelled = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter(b => b.offsetParent !== null)
      .map(b => ({ id: b.dataset.testid,
                   // The staged badge is a count indicator, not a label.
                   text: [...b.childNodes].filter(n => !n.classList ||
                          !n.classList.contains('badge'))
                          .map(n => n.textContent).join('').trim(),
                   svg: !!b.querySelector('svg'),
                   aria: b.getAttribute('aria-label') })));
  for (const b of labelled) {
    if (/^fmt-A[456]$/.test(b.id)) { expect(b.text).toMatch(/^A[456]$/); continue; }
    if (b.id === 'title-toggle') { expect(b.text).toBeTruthy(); continue; }
    // Filmstrip tiles are page thumbnails, not glyph buttons.
    if (/^film-\d+$/.test(b.id)) { expect(b.aria).toBeTruthy(); continue; }
    expect(b.text, `${b.id} should have no visible text`).toBe('');
    expect(b.svg, `${b.id} should carry an icon`).toBe(true);
    // Icon-only means the accessible name has to come from somewhere.
    expect(b.aria, `${b.id} needs an aria-label`).toBeTruthy();
  }
});

test('controls float over a full-bleed canvas', async ({ page }) => {
  await ready(page);
  const geo = await page.evaluate(() => {
    const cv = document.getElementById('cv').getBoundingClientRect();
    // The mode pill: always visible, unlike the page-setup panel.
    const pill = document.querySelector('[data-testid=mode-crop]')
                   .closest('.pill').getBoundingClientRect();
    return { cv: { w: cv.width, h: cv.height }, pill: { top: pill.top, bottom: pill.bottom },
             vw: innerWidth, vh: innerHeight };
  });
  // The canvas covers the viewport rather than being squeezed above a panel.
  expect(geo.cv.w).toBeCloseTo(geo.vw, 0);
  expect(geo.cv.h).toBeCloseTo(geo.vh, 0);
  // ...and the controls sit on top of it, not below.
  expect(geo.pill.bottom).toBeLessThanOrEqual(geo.vh);
  expect(geo.pill.top).toBeGreaterThan(geo.vh / 2);
});

test('icons render as strokes, not filled blobs', async ({ page }) => {
  await ready(page);
  // <use> clones only the symbol's subtree, so attributes on the sprite's root
  // <svg> are lost and the icon silently falls back to fill:black/stroke:none.
  const style = await page.evaluate(() => {
    const svg = document.querySelector('button svg');
    const cs = getComputedStyle(svg);
    return { fill: cs.fill, stroke: cs.stroke, width: cs.strokeWidth };
  });
  expect(style.fill).toBe('none');
  expect(style.stroke).not.toBe('none');
  expect(parseFloat(style.width)).toBeGreaterThan(0);
});

test('a few pixels of overhang does not raise the warning', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const p = window.state.page;
    window.state.frame = { cx: p.width / 2, cy: p.height / 2,
                           w: p.width + 6, h: (p.width + 6) * (297 / 210), angle: 0 };
    window.state.frame.h = Math.min(window.state.frame.h, p.height);
    window.render();
  });
  expect(await page.evaluate(() => window.outsideOverhangPx())).toBeLessThan(12);
  await expect(page.getByTestId('outside-flag')).toBeHidden();

  await page.evaluate(() => { window.state.frame.cy -= 300; window.render(); });
  await expect(page.getByTestId('outside-flag')).toBeVisible();
});

test('the dial appears only in straighten mode', async ({ page }) => {
  await ready(page);
  // `hidden` alone is not enough: a class setting `display` overrides the UA
  // stylesheet, so assert on visibility rather than on the attribute.
  await expect(page.getByTestId('dial')).toBeHidden();
  await page.getByTestId('mode-straighten').click();
  await expect(page.getByTestId('dial')).toBeVisible();
  await page.getByTestId('mode-crop').click();
  await expect(page.getByTestId('dial')).toBeHidden();
});

test('page size and rotation stay behind their own button', async ({ page }) => {
  await ready(page);
  for (const id of ['fmt-A4', 'fmt-A5', 'fmt-A6', 'btn-swap', 'btn-rotate'])
    await expect(page.getByTestId(id)).toBeHidden();
  await page.getByTestId('btn-pagesetup').click();
  for (const id of ['fmt-A4', 'fmt-A5', 'fmt-A6', 'btn-swap', 'btn-rotate'])
    await expect(page.getByTestId(id)).toBeVisible();
  await page.getByTestId('btn-pagesetup').click();
  await expect(page.getByTestId('fmt-A4')).toBeHidden();
});

test('the frame is visible and draggable in straighten mode too', async ({ page }) => {
  await ready(page);
  await page.getByTestId('mode-straighten').click();
  // Brackets are painted in both modes; dragging something invisible read as
  // the gesture being broken.
  const painted = await page.evaluate(() => {
    const cv = document.getElementById('cv');
    const r = window.frameRectOnScreen();
    const d = cv.getContext('2d').getImageData(
      Math.max(0, r.x | 0), Math.max(0, r.y | 0), 30, 30).data;
    let white = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230) white++;
    return white;
  });
  expect(painted).toBeGreaterThan(20);

  const before = await frameOf(page);
  const box = await page.getByTestId('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + 70, cy + 50, { steps: 10 }); await page.mouse.up();
  const after = await frameOf(page);
  expect(Math.hypot(after.cx - before.cx, after.cy - before.cy)).toBeGreaterThan(1);
});

test('dragging moves the frame by the damped distance, not a compounding one',
  async ({ page }) => {
    await ready(page);
    const box = await page.getByTestId('canvas').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

    // Cross the activation threshold FIRST, then measure. Including the
    // threshold in the sum made the expectation depend on exactly which move
    // event crossed it, which changes with the image and the step size.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 30, cy, { steps: 6 });
    const armed = await frameOf(page);

    const { s, dpr, gain } = await page.evaluate(() => {
      const cv = document.getElementById('cv');
      return { s: Math.min((cv.width - 40) / window.state.img.naturalWidth,
                           (cv.height - 40) / window.state.img.naturalHeight),
               dpr: window.devicePixelRatio || 1, gain: window.moveGain() };
    });

    // Many small steps: the old handler measured each delta against an origin
    // it had just moved, so movement grew with the NUMBER of pointer events.
    for (let i = 1; i <= 8; i++) await page.mouse.move(cx + 30 + i * 5, cy);
    const half = await frameOf(page);
    for (let i = 9; i <= 16; i++) await page.mouse.move(cx + 30 + i * 5, cy);
    await page.mouse.up();
    const after = await frameOf(page);

    const first = half.cx - armed.cx, second = after.cx - half.cx;
    // Linear: two equal drags move the frame equally. Compounding made the
    // second far larger than the first.
    expect(second / first).toBeCloseTo(1, 1);

    // Damped by the expected factor. Compared as a ratio with a 5% tolerance
    // rather than to the pixel: cv.width is rounded from clientWidth * dpr, so
    // recomputing the scale here agrees only to about a percent. The failures
    // this guards against are 855% (compounding) and 233% (no damping).
    const expected = (80 * dpr / s) * gain;
    expect((after.cx - armed.cx) / expected).toBeCloseTo(1, 1);
  });

test('the title pill matches the height of the buttons beside it', async ({ page }) => {
  await ready(page);
  const h = await page.evaluate(() => {
    const grow = document.getElementById('nav').getBoundingClientRect();
    const pill = document.querySelector('[data-testid=btn-accept]')
                   .closest('.pill').getBoundingClientRect();
    return { grow: grow.height, pill: pill.height };
  });
  expect(h.grow).toBeCloseTo(h.pill, 0);
});

test('the queue count is legible and never truncated away', async ({ page }) => {
  await ready(page);
  const info = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=queue-count]');
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    return { text: c.textContent.trim(), w: r.width,
             scroll: c.scrollWidth, client: c.clientWidth,
             size: parseFloat(cs.fontSize) };
  });
  expect(info.text).toMatch(/^\d+\/\d+$/);
  expect(info.w).toBeGreaterThan(20);                        // laid out, not collapsed
  expect(info.scroll).toBeLessThanOrEqual(info.client + 1);  // not clipped
  expect(info.size).toBeGreaterThanOrEqual(13);
});

test('the title collapses to a queue position on mobile and expands on tap',
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'phone layout only');
    await ready(page);
    const toggle = page.getByTestId('title-toggle');

    // Collapsed: just "n/m", small enough to sit between the button clusters.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('page-title')).toBeHidden();
    await expect(page.getByTestId('queue-count')).toBeVisible();
    const nav = page.locator('#nav');
    const narrow = (await nav.boundingBox()).width;
    const vw = await page.evaluate(() => innerWidth);
    // Compact: the pill holds prev + badge + next, not the whole bar.
    expect(narrow).toBeLessThan(vw / 2);
    // ...and it shares the row with the buttons rather than taking its own.
    const rowShared = await page.evaluate(() => {
      const t = document.getElementById('nav').getBoundingClientRect();
      // Compare pill to pill: the button sits 5px inside its own pill.
      const b = document.querySelector('[data-testid=btn-accept]')
                  .closest('.pill').getBoundingClientRect();
      return Math.abs(t.top - b.top) < 4;
    });
    expect(rowShared).toBe(true);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('page-title')).toBeVisible();
    const wide = (await nav.boundingBox()).width;
    expect(wide).toBeGreaterThan(vw * 0.8);

    await toggle.click();
    await expect(page.getByTestId('page-title')).toBeHidden();
  });

test('the badge tracks the document position, and a sent document leaves',
  async ({ page }) => {
    await ready(page);
    const first = await page.getByTestId('queue-count').textContent();
    expect(first).toMatch(/^1\/(\d+)$/);
    const total = Number(first.split('/')[1]);
    expect(total).toBeGreaterThan(1);

    // Decide the whole document, then send it.
    await decideAll(page);
    await page.getByTestId('btn-finalize').click();
    await expect(page.getByTestId('status')).toContainText('paperless');
    // One fewer document, and we are on the one that took its place.
    await expect(page.getByTestId('queue-count')).toHaveText(`1/${total - 1}`);
  });

test('next and previous walk the documents and the badge follows', async ({ page }) => {
  await ready(page);
  const total = Number((await page.getByTestId('queue-count').textContent()).split('/')[1]);
  expect(total).toBeGreaterThanOrEqual(3);
  const firstBatch = await page.evaluate(() => window.currentDoc().batch);

  await page.getByTestId('btn-next').click();
  await expect(page.getByTestId('queue-count')).toHaveText(`2/${total}`);
  const secondBatch = await page.evaluate(() => window.currentDoc().batch);
  expect(secondBatch).not.toBe(firstBatch);

  await page.getByTestId('btn-prev').click();
  await expect(page.getByTestId('queue-count')).toHaveText(`1/${total}`);
  expect(await page.evaluate(() => window.currentDoc().batch)).toBe(firstBatch);
});

test('navigation stops at both ends rather than wrapping', async ({ page }) => {
  await ready(page);
  const total = Number((await page.getByTestId('queue-count').textContent()).split('/')[1]);
  await expect(page.getByTestId('btn-prev')).toBeDisabled();
  await expect(page.getByTestId('btn-next')).toBeEnabled();
  for (let i = 1; i < total; i++) await page.getByTestId('btn-next').click();
  await expect(page.getByTestId('queue-count')).toHaveText(`${total}/${total}`);
  await expect(page.getByTestId('btn-next')).toBeDisabled();
  await expect(page.getByTestId('btn-prev')).toBeEnabled();
});

test('edits survive stepping away and back', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    window.state.frame.cx += 120; window.state.frame.cy -= 60; window.render();
  });
  const edited = await frameOf(page);
  await page.getByTestId('btn-next').click();
  const other = await frameOf(page);
  expect(other.cx).not.toBeCloseTo(edited.cx, 1);
  await page.getByTestId('btn-prev').click();
  const back = await frameOf(page);
  // Navigating away must not silently discard work.
  expect(back.cx).toBeCloseTo(edited.cx, 3);
  expect(back.cy).toBeCloseTo(edited.cy, 3);
});

test('the floating controls never cover the frame corners', async ({ page }) => {
  await ready(page);
  // A control laid over a corner silently eats the drag that would resize it.
  const clash = await page.evaluate(() => {
    const r = window.frameRectOnScreen();
    const dpr = window.devicePixelRatio || 1;
    const cvBox = document.getElementById('cv').getBoundingClientRect();
    const corners = [[r.x, r.y], [r.x + r.w, r.y],
                     [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]
      .map(([x, y]) => [cvBox.x + x / dpr, cvBox.y + y / dpr])
      .filter(([x, y]) => x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight);
    return corners.map(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el && el.id === 'cv' ? null : (el && (el.dataset.testid || el.className));
    }).filter(Boolean);
  });
  expect(clash).toEqual([]);
});

test('ingest measures the content angle and levels the frame to it',
  async ({ request }) => {
    const withText = (await allPages(request)).filter(p => p.text_skew);
    expect(withText.length).toBeGreaterThan(0);
    for (const p of withText) {
      const t = p.text_skew;
      expect(typeof t.residual_deg).toBe('number');
      expect(typeof t.confident).toBe('boolean');
      if (t.confident) {
        // The content angle wins: the seeded frame is the sheet angle plus the
        // measured residual.
        expect(p.seeded.angle).toBeCloseTo(t.sheet_angle + t.residual_deg, 6);
      } else {
        // Not measurable (blank, sparse, a photo) - the sheet angle stands.
        expect(p.seeded.angle).toBeCloseTo(t.sheet_angle, 6);
      }
    }
    // At least one real scan should actually be measurable.
    expect(withText.some(p => p.text_skew.confident)).toBe(true);
  });

/** Accept every page of the document the queue starts on. */
async function acceptWholeBatch(page) {
  const batch = await page.evaluate(() => window.currentDoc().batch);
  const n = await page.evaluate(() => window.currentDoc().pages.length);
  for (let i = 0; i < n; i++) {
    await page.getByTestId('btn-accept').click();
    await expect(page.getByTestId('status')).toContainText('accepted');
  }
  return { batch, n };
}

test('one ADF batch is one document, and Send is scoped to it', async ({ page, request }) => {
  await ready(page);
  const batch = (await gotoDoc(page, 'fx-letter')).batch;
  const n = await decideAll(page);
  expect(n).toBeGreaterThan(0);

  // You stay on the document you just finished, with Send lit.
  const docs = await (await request.get('/api/queue')).json();
  const doc = docs.documents.find(d => d.batch === batch);
  expect(doc.counts.accepted).toBe(n);
  expect(doc.ready).toBe(true);
  await expect(page.getByTestId('btn-finalize')).toBeEnabled();
  await expect(page.getByTestId('page-count')).toHaveText(String(n));

  await page.getByTestId('btn-finalize').click();
  await expect(page.getByTestId('status')).toContainText('paperless');
  const after = await (await request.get('/api/queue')).json();
  expect(after.documents.find(d => d.batch === batch)).toBeUndefined();
});

test('each page goes into the PDF at its own true size', async ({ request }) => {
  const { execSync } = require('child_process');
  const pages = await allPages(request);
  // The blank A6 note is a batch of one, and landscape - the case a fixed A4
  // layout silently destroyed.
  const note = pages.find(p => p.seeded && p.seeded.format === 'A6');
  expect(note).toBeTruthy();
  const corners = (f) => {
    const hw = f.w / 2, hh = f.h / 2, a = f.angle * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
      .map(([x, y]) => [f.cx + x * ca - y * sa, f.cy + x * sa + y * ca]);
  };
  await request.post(`/api/accept/${encodeURIComponent(note.id)}`, {
    data: { corners: corners(note.seeded), frame: note.seeded, rotation: 0,
            target: note.seeded.format } });
  const fin = await (await request.post(
    `/api/finalize/${encodeURIComponent(note.batch)}`)).json();
  const pdf = path.join(__dirname, '..', 'mock-paperless', 'consume', fin.pdf);
  const info = execSync(`pdfinfo -f 1 -l 1 ${pdf}`).toString();
  const m = info.match(/Page\s+1 size:\s+([\d.]+) x ([\d.]+) pts/);
  const [w, h] = [Number(m[1]), Number(m[2])];
  // A6 landscape is 148 x 105 mm = 419.5 x 297.6 pts. NOT 595 x 842 (A4).
  expect(w / 72 * 25.4).toBeCloseTo(148, 0);
  expect(h / 72 * 25.4).toBeCloseTo(105, 0);
});

test('the top bar stays on one row at common phone widths', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone layout only');
  // It used to fit at exactly 412px and wrap at 390, 375 and 360 - which is
  // most phones - pushing accept and reject onto a second row.
  for (const width of [360, 375, 390, 412]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page.waitForFunction(() => window.state && window.state.img);
    const rows = await page.evaluate(() => new Set(
      [...document.getElementById('top').children]
        .map(k => Math.round(k.getBoundingClientRect().top))).size);
    expect(rows, `top bar wrapped at ${width}px`).toBe(1);
    await expect(page.getByTestId('btn-accept')).toBeVisible();
    await expect(page.getByTestId('btn-reject')).toBeVisible();

    // One permanently visible bottom bar, on one row, with every control on it.
    const bottom = await page.evaluate(() => {
      const tb = document.getElementById('toolbar');
      return {
        btnRows: new Set([...tb.querySelectorAll('button')]
          .filter(b => b.offsetParent !== null)
          .map(b => Math.round(b.getBoundingClientRect().top))).size,
        buttons: [...tb.querySelectorAll('button')]
          .filter(b => b.offsetParent !== null).length,
        // The filmstrip is expected alongside it; what must not double is the
        // toolbar itself.
        visibleBars: [...document.getElementById('controls').children]
          .filter(c => c.classList.contains('pill')
                    && c.getBoundingClientRect().height > 0).length,
        overflow: tb.scrollWidth > tb.clientWidth + 1,
      };
    });
    expect(bottom.btnRows, `toolbar wrapped at ${width}px`).toBe(1);
    expect(bottom.overflow, `toolbar overflowed at ${width}px`).toBe(false);
    expect(bottom.buttons).toBe(8);
    expect(bottom.visibleBars, `two toolbars visible at ${width}px`).toBe(1);
    await expect(page.getByTestId('toolbar-sep')).toBeVisible();
  }
});

test('undo and reset are disabled when there is nothing to undo or reset',
  async ({ page }) => {
    await ready(page);
    const undo = page.getByTestId('btn-undo');
    const reset = page.getByTestId('btn-reset');
    await expect(undo).toBeDisabled();
    await expect(reset).toBeDisabled();

    // A tap that changes nothing must not enable them.
    const box = await page.getByTestId('canvas').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + 3, cy + 2); await page.mouse.up();
    await expect(undo).toBeDisabled();
    await expect(reset).toBeDisabled();

    // A real change enables both.
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + 70, cy + 50, { steps: 10 }); await page.mouse.up();
    await expect(undo).toBeEnabled();
    await expect(reset).toBeEnabled();

    // Undoing back to the start disables them again.
    await undo.click();
    await expect(undo).toBeDisabled();
    await expect(reset).toBeDisabled();
  });

test('reset disables itself once it has been used', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { window.pushHistory(); window.setDial(2.0); });
  await expect(page.getByTestId('btn-reset')).toBeEnabled();
  await page.getByTestId('btn-reset').click();
  await expect(page.getByTestId('btn-reset')).toBeDisabled();
  // Reset clears the history too, so Undo has nothing left either.
  await expect(page.getByTestId('btn-undo')).toBeDisabled();
});

test('a tap on the dial that moves nothing does not enable undo', async ({ page }) => {
  await ready(page);
  await page.getByTestId('mode-straighten').click();
  const box = await page.getByTestId('dial').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up();
  await expect(page.getByTestId('btn-undo')).toBeDisabled();
  // One pixel of drag IS a real step - the dial runs at about 11px per degree,
  // so a pixel snaps to 0.1 - and must therefore enable it.
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 4, y); await page.mouse.up();
  await expect(page.getByTestId('btn-undo')).toBeEnabled();
});

/** Navigate to a named fixture document.
 *
 * Not "the first document with more than one page": reset() re-ingests consumed
 * pages, so ingest order - and therefore document order - differs between runs,
 * and a positional search lands somewhere different each time.
 */
async function gotoDoc(page, prefix) {
  const i = await page.evaluate(
    (p) => window.state.documents.findIndex(d => d.batch.startsWith(p)), prefix);
  expect(i, `no document matching ${prefix}`).toBeGreaterThanOrEqual(0);
  await page.evaluate(async (k) => {
    window.state.docIndex = k;
    window.state.pageIndex = 0;
    await window.showPage();
  }, i);
  return page.evaluate(() => window.currentDoc());
}

/** Decide every page of the current document.
 *
 * Waits for each decision to land rather than firing clicks back to back: the
 * status text does not change between two accepts, so it is not a barrier. */
async function decideAll(page, which = 'btn-accept') {
  const n = await page.evaluate(() => window.currentDoc().pages.length);
  const key = which === 'btn-accept' ? 'accepted' : 'rejected';
  for (let i = 1; i <= n; i++) {
    await page.getByTestId(which).click();
    await page.waitForFunction(
      ([k, want]) => window.currentDoc().counts[k] === want, [key, i]);
  }
  return n;
}

/** Hold a drag open so mid-gesture state can be inspected. */
async function beginDrag(page, from, to) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
}

test('moving the frame shows a magnified loupe at each corner', async ({ page }) => {
  await ready(page);
  expect(await page.evaluate(() => (window.state.loupes || []).length)).toBe(0);

  const box = await page.getByTestId('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await beginDrag(page, [cx, cy], [cx + 70, cy + 50]);

  const loupes = await page.evaluate(() => window.state.loupes);
  expect(loupes).toHaveLength(4);
  // One per frame corner, each in its own screen corner.
  expect(loupes.map(l => l.corner).sort()).toEqual([0, 1, 2, 3]);
  expect(new Set(loupes.map(l => l.spot)).size).toBe(4);

  // They must be inside the canvas and clear of the floating bars.
  const bars = await page.evaluate(() => {
    const dpr = window.devicePixelRatio || 1;
    return { top: document.getElementById('top').getBoundingClientRect().height * dpr,
             ctl: document.getElementById('controls').getBoundingClientRect().height * dpr,
             w: document.getElementById('cv').width,
             h: document.getElementById('cv').height };
  });
  for (const l of loupes) {
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.y).toBeGreaterThanOrEqual(bars.top);
    expect(l.x + l.size).toBeLessThanOrEqual(bars.w);
    expect(l.y + l.size).toBeLessThanOrEqual(bars.h - bars.ctl);
  }

  await page.mouse.up();
  expect(await page.evaluate(() => window.state.loupes.length)).toBe(0);
});

test('the loupe is actually magnified and carries a crossbar', async ({ page }) => {
  await ready(page);
  const box = await page.getByTestId('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await beginDrag(page, [cx, cy], [cx + 70, cy + 50]);

  const probe = await page.evaluate(() => {
    const l = window.state.loupes[0];
    const d = document.getElementById('cv').getContext('2d')
      .getImageData(l.x, l.y, l.size, l.size).data;
    let red = 0, painted = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      painted++;
      // Dominance, not absolute values: the crossbar antialiases against the
      // page and never saturates at devicePixelRatio 1.
      if (d[i] - d[i + 1] > 40 && d[i] - d[i + 2] > 40) red++;
    }
    return { red, painted, zoom: window.LOUPE_ZOOM_FOR_TEST };
  });
  // The crossbar spans the full width and height of the loupe.
  expect(probe.red).toBeGreaterThan(100);
  expect(probe.painted).toBeGreaterThan(1000);
  await page.mouse.up();
});

test('resizing a corner magnifies it and both neighbours, never the opposite',
  async ({ page }) => {
    await ready(page);
    const r = await page.evaluate(() => {
      const q = window.frameRectOnScreen();
      const b = document.getElementById('cv').getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return { x: b.x + q.x / dpr, y: b.y + q.y / dpr };
    });
    await beginDrag(page, [r.x, r.y], [r.x + 50, r.y + 50]);
    const loupes = await page.evaluate(() => window.state.loupes);

    // Dragging the top-left (0): show 0, 1 and 3. The opposite corner (2) is
    // the anchor - it does not move, so there is nothing to watch.
    expect(loupes).toHaveLength(3);
    expect(loupes.map(l => l.corner).sort()).toEqual([0, 1, 3]);
    expect(loupes.map(l => l.corner)).not.toContain(2);

    // Each in its own screen corner, and the dragged one moved across so the
    // hand is not over it.
    expect(new Set(loupes.map(l => l.spot)).size).toBe(3);
    expect(loupes.find(l => l.corner === 0).spot).toBe(2);
    expect(loupes.find(l => l.corner === 1).spot).toBe(1);
    expect(loupes.find(l => l.corner === 3).spot).toBe(3);
    await page.mouse.up();
  });

test('a decided page can be reopened until it is sent', async ({ request }) => {
  // From a multi-page document: rejecting the only page of a single-page one
  // empties the document, which then leaves the queue and takes the page's
  // reopen path with it. See "Known limits" in the README.
  const { documents } = await (await request.get('/api/queue')).json();
  const doc = fixtures(documents).find(d => d.counts.total > 1);
  const p = doc.pages.find(x => x.status === 'pending');
  await request.post(`/api/reject/${encodeURIComponent(p.id)}`);
  let after = (await allPages(request)).find(x => x.id === p.id);
  expect(after.status).toBe('rejected');

  const r = await request.post(`/api/reopen/${encodeURIComponent(p.id)}`);
  expect(r.ok()).toBeTruthy();
  after = (await allPages(request)).find(x => x.id === p.id);
  expect(after.status).toBe('pending');
});

test('reopening an unknown page is a 404', async ({ request }) => {
  const r = await request.post('/api/reopen/nope.png');
  expect(r.status()).toBe(404);
});

test('a sent page cannot be reopened, and finalize needs a decided document',
  async ({ request }) => {
    const { documents } = await (await request.get('/api/queue')).json();
    const doc = fixtures(documents).find(d => d.counts.total > 1);

    const early = await request.post(`/api/finalize/${encodeURIComponent(doc.batch)}`);
    expect(early.status()).toBe(409);

    const corners = (f) => {
      const hw = f.w / 2, hh = f.h / 2, a = f.angle * Math.PI / 180;
      const ca = Math.cos(a), sa = Math.sin(a);
      return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
        .map(([x, y]) => [f.cx + x * ca - y * sa, f.cy + x * sa + y * ca]);
    };
    for (const p of doc.pages) {
      await request.post(`/api/accept/${encodeURIComponent(p.id)}`, {
        data: { corners: corners(p.seeded), frame: p.seeded, rotation: 0,
                target: p.seeded.format } });
    }
    const fin = await request.post(`/api/finalize/${encodeURIComponent(doc.batch)}`);
    expect(fin.ok()).toBeTruthy();

    const after = await (await request.get('/api/queue')).json();
    expect(after.documents.find(d => d.batch === doc.batch)).toBeUndefined();
    const r = await request.post(`/api/reopen/${encodeURIComponent(doc.pages[0].id)}`);
    expect(r.status()).toBe(409);
  });

test('a wholly declined document stays until deleted, then goes', async ({ request }) => {
  const { documents } = await (await request.get('/api/queue')).json();
  const doc = fixtures(documents).find(d => d.counts.total === 1);
  expect(doc, 'need a single-page fixture document').toBeTruthy();

  await request.post(`/api/reject/${encodeURIComponent(doc.pages[0].id)}`);
  let q = await (await request.get('/api/queue')).json();
  let still = q.documents.find(d => d.batch === doc.batch);
  // It must NOT vanish - otherwise the reject could never be undone.
  expect(still).toBeTruthy();
  expect(still.deletable).toBe(true);
  expect(still.ready).toBe(true);

  // Nothing to send, so finalize refuses.
  const fin = await request.post(`/api/finalize/${encodeURIComponent(doc.batch)}`);
  expect(fin.ok()).toBeFalsy();

  const del = await request.post(`/api/discard/${encodeURIComponent(doc.batch)}`);
  expect(del.ok()).toBeTruthy();
  q = await (await request.get('/api/queue')).json();
  expect(q.documents.find(d => d.batch === doc.batch)).toBeUndefined();

  // The scan is kept, out of the queue, rather than erased.
  const fs = require('fs'), path = require('path');
  expect(fs.existsSync(path.join(__dirname, '..', 'spool-archive',
                                 doc.pages[0].id))).toBe(true);
});

test('a document with something to keep cannot be deleted', async ({ request }) => {
  const { documents } = await (await request.get('/api/queue')).json();
  const doc = fixtures(documents).find(d => d.counts.total > 1);
  const corners = (f) => {
    const hw = f.w / 2, hh = f.h / 2, a = f.angle * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
      .map(([x, y]) => [f.cx + x * ca - y * sa, f.cy + x * sa + y * ca]);
  };
  const p = doc.pages[0];
  await request.post(`/api/accept/${encodeURIComponent(p.id)}`, {
    data: { corners: corners(p.seeded), frame: p.seeded, rotation: 0,
            target: p.seeded.format } });
  const del = await request.post(`/api/discard/${encodeURIComponent(doc.batch)}`);
  expect(del.status()).toBe(409);
});

test('thumbnails are small and cached', async ({ request }) => {
  const p = (await allPages(request))[0];
  const r = await request.get(`/api/thumb/${encodeURIComponent(p.id)}`);
  expect(r.ok()).toBeTruthy();
  expect(r.headers()['content-type']).toContain('image/jpeg');
  const thumb = (await r.body()).length;
  const full = (await (await request.get(
    `/api/image/${encodeURIComponent(p.id)}`)).body()).length;
  // The filmstrip cannot afford the full PNG: five of those is megabytes.
  expect(thumb).toBeLessThan(full / 10);

  const fs = require('fs'), path = require('path');
  expect(fs.existsSync(path.join(__dirname, '..', 'work', 'thumbs',
                                 p.id + '.jpg'))).toBe(true);
});

test('the filmstrip shows every page of the current document with its state',
  async ({ page }) => {
    await ready(page);
    const doc = await page.evaluate(() => window.currentDoc());
    const films = page.locator('#filmstrip .film');
    await expect(films).toHaveCount(doc.pages.length);
    await expect(page.locator('#filmstrip .film[aria-current=true]')).toHaveCount(1);
    await page.getByTestId('btn-reject').click();
    await expect(page.locator('#filmstrip .film[data-state=rejected]')).toHaveCount(1);
  });

test('the chevrons step documents, not pages', async ({ page }) => {
  await ready(page);
  const first = await page.evaluate(() => window.currentDoc().batch);
  const total = await page.evaluate(() => window.state.documents.length);
  expect(total).toBeGreaterThan(1);
  await page.getByTestId('btn-next').click();
  const second = await page.evaluate(() => window.currentDoc().batch);
  expect(second).not.toBe(first);
  await expect(page.getByTestId('queue-count')).toHaveText(`2/${total}`);
});

test('accepting a page advances to the next undecided one in the document',
  async ({ page }) => {
    await ready(page);
    const doc = await gotoDoc(page, 'fx-letter');
    expect(doc.pages.length).toBeGreaterThan(1);
    const before = await page.evaluate(() => window.currentPage().id);
    await page.getByTestId('btn-accept').click();
    // The status text is set BEFORE accept() reloads and re-renders, so it is
    // not a barrier - waiting on it and then reading state is a race. The
    // filmstrip's current marker moves only once showPage() has finished.
    await expect(page.locator('#filmstrip .film[aria-current=true]'))
      .toHaveAttribute('data-testid', 'film-1');

    const after = await page.evaluate(() => window.currentPage().id);
    expect(after).not.toBe(before);
    expect(await page.evaluate(() => window.currentPage().status)).toBe('pending');
  });

test('tapping a decided page in the filmstrip reopens it', async ({ page }) => {
  await ready(page);
  await page.getByTestId('btn-reject').click();
  const rejected = page.locator('#filmstrip .film[data-state=rejected]').first();
  await expect(rejected).toHaveCount(1);
  await rejected.click();
  await expect(page.locator('#filmstrip .film[data-state=rejected]')).toHaveCount(0);
  expect(await page.evaluate(() => window.currentPage().status)).toBe('pending');
});

test('deciding the last page leaves you put and lights Send', async ({ page }) => {
  await ready(page);
  await gotoDoc(page, 'fx-letter');
  const n = await decideAll(page);
  expect(await page.evaluate(() => window.currentDoc().ready)).toBe(true);
  await expect(page.getByTestId('btn-finalize')).toBeEnabled();
  await expect(page.getByTestId('btn-finalize')).toHaveAttribute('data-action', 'send');
  await expect(page.getByTestId('page-count')).toHaveText(String(n));
});

test('Send becomes Delete when every page is declined', async ({ page }) => {
  await ready(page);
  await gotoDoc(page, 'fx-note');
  await decideAll(page, 'btn-reject');
  await expect(page.getByTestId('btn-finalize')).toHaveAttribute('data-action', 'delete');
  await expect(page.getByTestId('btn-finalize')).toBeEnabled();
  const batch = await page.evaluate(() => window.currentDoc().batch);
  await page.getByTestId('btn-finalize').click();
  await expect(page.getByTestId('status')).toContainText('deleted');
  // Same race as above: the status is set before the reload finishes, so wait
  // for the document list itself to lose the batch.
  await page.waitForFunction(
    (b) => !window.state.documents.some(d => d.batch === b), batch);
});

test('filmstrip tiles are page-shaped, not the generic round buttons',
  async ({ page }) => {
    await ready(page);
    // `button:not(.grow)` is more specific than a bare `.film`, so the tiles
    // silently inherited the 44px circle used everywhere else.
    const box = await page.evaluate(() => {
      const b = document.querySelector('#filmstrip .film');
      const r = b.getBoundingClientRect();
      return { w: r.width, h: r.height,
               radius: getComputedStyle(b).borderRadius };
    });
    expect(box.h).toBeGreaterThan(box.w);         // portrait, like a page
    expect(box.w).toBeCloseTo(52, 0);
    expect(box.h).toBeCloseTo(68, 0);
    expect(parseFloat(box.radius)).toBeLessThan(20);   // not a circle
  });

test('the filmstrip toggles like the gridlines do', async ({ page }) => {
  await ready(page);
  const strip = page.locator('#filmstrip');
  const toggle = page.getByTestId('film-toggle');
  await expect(strip).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await toggle.click();
  await expect(strip).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // Hidden, not merely emptied: the pages are still there to come back to.
  expect(await page.evaluate(() => window.currentDoc().pages.length))
    .toBeGreaterThan(0);

  await toggle.click();
  await expect(strip).toBeVisible();
  await expect(page.locator('#filmstrip .film')).toHaveCount(
    await page.evaluate(() => window.currentDoc().pages.length));
});

test('the filmstrip stays hidden across pages and documents', async ({ page }) => {
  await ready(page);
  await page.getByTestId('film-toggle').click();
  await expect(page.locator('#filmstrip')).toBeHidden();
  await page.getByTestId('btn-next').click();
  await expect(page.locator('#filmstrip')).toBeHidden();
  await page.getByTestId('btn-reject').click();
  await expect(page.locator('#filmstrip')).toBeHidden();
});

test('the page count sits on the strip toggle, not on Send', async ({ page }) => {
  await ready(page);
  const doc = await gotoDoc(page, 'fx-letter');
  const n = doc.pages.length;
  expect(n).toBeGreaterThan(1);
  await expect(page.getByTestId('page-count')).toHaveText(String(n));
  // Send carries no badge at all now.
  expect(await page.locator('[data-testid=btn-finalize] .badge').count()).toBe(0);

  // It counts the document's PAGES, so deciding one does not change it.
  await page.getByTestId('btn-accept').click();
  await page.waitForFunction(() => window.currentDoc().counts.accepted === 1);
  await expect(page.getByTestId('page-count')).toHaveText(String(n));
});

// ------------------------------------------------------------ desktop zoom

/** Which image pixel sits under a client-space point. The frame does not move
 *  during a zoom, so comparing this before and after says whether the point
 *  under the cursor stayed put. Uses the app's own transform, not a copy. */
async function imagePointUnder(page, clientX, clientY) {
  return page.evaluate(([cx, cy]) => {
    const cv = document.querySelector('[data-testid="canvas"]');
    const b = cv.getBoundingClientRect();
    return window.toImage([(cx - b.left) * (cv.width / b.width),
                           (cy - b.top) * (cv.height / b.height)]);
  }, [clientX, clientY]);
}
const zoomOf = page => page.evaluate(() => window.state.view.zoom);
const viewOf = page => page.evaluate(() => ({ ...window.state.view }));

test('the wheel zooms and holds the point under the cursor still', async ({ page }) => {
  await ready(page);
  const box = await page.getByTestId('canvas').boundingBox();
  // Deliberately off-centre: a bug that zooms about the canvas centre instead
  // of the cursor still passes when the cursor IS the centre.
  const x = box.x + box.width * 0.3, y = box.y + box.height * 0.65;

  const before = await imagePointUnder(page, x, y);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -400);
  await page.waitForFunction(() => window.state.view.zoom > 1);
  const after = await imagePointUnder(page, x, y);

  expect(await zoomOf(page)).toBeGreaterThan(1);
  // Sub-pixel tolerance. Canvas points are integers and the image is ~1664px
  // wide, so a correct anchor still drifts a fraction of an image pixel on the
  // smaller mobile canvas. The bug this guards against -- zooming about the
  // canvas centre -- moves this point by hundreds of pixels, not two.
  expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeLessThan(2);
});

test('the wheel does not move the crop frame', async ({ page }) => {
  await ready(page);
  const before = await frameOf(page);
  const box = await page.getByTestId('canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForFunction(() => window.state.view.zoom > 1);
  const after = await frameOf(page);
  for (const k of ['cx', 'cy', 'w', 'h', 'angle'])
    expect(after[k]).toBeCloseTo(before[k], 6);
});

test('wheeling back out stops at fit and never goes below it', async ({ page }) => {
  await ready(page);
  const box = await page.getByTestId('canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
  expect(await zoomOf(page)).toBe(1);
});

test('right-drag pans the sheet and leaves the crop alone', async ({ page }) => {
  await ready(page);
  const box = await page.getByTestId('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -400);                    // zoom in so panning shows
  await page.waitForFunction(() => window.state.view.zoom > 1);

  const frameBefore = await frameOf(page);
  const viewBefore = await viewOf(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 80, cy + 50, { steps: 10 });
  await page.mouse.up({ button: 'right' });

  const viewAfter = await viewOf(page);
  const frameAfter = await frameOf(page);
  expect(viewAfter.panX).not.toBeCloseTo(viewBefore.panX, 1);
  expect(viewAfter.panY).not.toBeCloseTo(viewBefore.panY, 1);
  expect(viewAfter.zoom).toBeCloseTo(viewBefore.zoom, 6);
  // The sheet moved; the crop did not.
  for (const k of ['cx', 'cy', 'w', 'h', 'angle'])
    expect(frameAfter[k]).toBeCloseTo(frameBefore[k], 6);
});

test('right-drag over the crop core pans instead of moving it', async ({ page }) => {
  await ready(page);
  // Centre of the canvas is inside the frame core, where a LEFT drag moves it.
  const box = await page.getByTestId('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const before = await frameOf(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 70, cy + 40, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  const after = await frameOf(page);
  expect(after.cx).toBeCloseTo(before.cx, 6);
  expect(after.cy).toBeCloseTo(before.cy, 6);
});

test('the canvas suppresses its context menu so right-drag is usable',
  async ({ page }) => {
    await ready(page);
    const prevented = await page.evaluate(() => {
      const cv = document.querySelector('[data-testid="canvas"]');
      const ev = new MouseEvent('contextmenu', { cancelable: true, bubbles: true });
      cv.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });

// The -/readout/+ group is CSS-hidden below 900px: a phone has pinch already
// and the toolbar has no room. Wheel, right-drag and the keys stay live at all
// widths, so only these two tests are desktop-only.
test.describe('desktop zoom controls', () => {
  // Gate on the viewport, which is the actual reason -- the CSS breakpoint --
  // rather than on the project name, which only correlates with it.
  test.beforeEach(({ viewport }) => {
    test.skip((viewport ? viewport.width : 0) < 900,
              'the zoom button group is only shown at >=900px');
  });

test('the zoom buttons step a ladder and the readout tracks them',
  async ({ page }) => {
    await ready(page);
    await expect(page.getByTestId('zoom-readout')).toHaveText('100%');
    await page.getByTestId('zoom-in').click();
    await expect(page.getByTestId('zoom-readout')).toHaveText('150%');
    await page.getByTestId('zoom-in').click();
    await expect(page.getByTestId('zoom-readout')).toHaveText('200%');
    await page.getByTestId('zoom-out').click();
    await expect(page.getByTestId('zoom-readout')).toHaveText('150%');
    expect(await zoomOf(page)).toBeCloseTo(1.5, 6);
  });

test('stepping back out to fit recentres the sheet', async ({ page }) => {
  await ready(page);
  const box = await page.getByTestId('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.wheel(0, -600);
  await page.waitForFunction(() => window.state.view.zoom > 1);
  // Pan it well away from centre, the state a right-drag can leave behind.
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 150, cy + 120, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  expect((await viewOf(page)).panX).not.toBe(0);

  // Zoom out disables itself at fit, so click only while it is live.
  const out = page.getByTestId('zoom-out');
  for (let i = 0; i < 10 && await out.isEnabled(); i++) await out.click();
  await expect(out).toBeDisabled();          // it really did reach the bottom
  const v = await viewOf(page);
  expect(v.zoom).toBe(1);
  expect(v.panX).toBe(0);          // back to fit means back to centre
  expect(v.panY).toBe(0);
});

});   // desktop zoom controls

test('plus, minus and zero work from the keyboard', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('+');
  expect(await zoomOf(page)).toBeCloseTo(1.5, 6);
  await page.keyboard.press('-');
  expect(await zoomOf(page)).toBeCloseTo(1, 6);
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await page.keyboard.press('0');
  const v = await viewOf(page);
  expect(v.zoom).toBe(1);
  expect(v.panX).toBe(0);
});

test('zoom resets when moving to another page', async ({ page }) => {
  await ready(page);
  const box = await page.getByTestId('canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForFunction(() => window.state.view.zoom > 1);
  await page.getByTestId('btn-next').click();
  await page.waitForFunction(() => window.state && window.state.img);
  expect(await zoomOf(page)).toBe(1);
});
