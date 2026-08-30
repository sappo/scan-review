// End-to-end verification against the REAL scans of the user's sheets.
// Assertions target observable outcomes: pixel dimensions, aspect ratios,
// files on disk, PDF page count, the mock's delivery log.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TRUTH = path.join(ROOT, 'groundtruth');
const BASE = 'http://127.0.0.1:8765';
const deliveries = () => {
  const p = path.join(ROOT, 'mock-paperless', 'deliveries.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
};

function truthRecord(id) {
  const p = path.join(TRUTH, id + '.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function resetPipeline() {
  for (const f of fs.readdirSync(TRUTH)) if (f.endsWith('.json')) fs.unlinkSync(path.join(TRUTH, f));
  for (const f of ['work/state.json', 'mock-paperless/deliveries.json']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  for (const dir of ['work', 'out', 'mock-paperless/consume']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (f.endsWith('.page.png') || f.endsWith('.pdf')) fs.unlinkSync(path.join(ROOT, dir, f));
    }
  }
}
const handlePos = (page, i) => page.evaluate((idx) => {
  const c = document.getElementById('cv'), r = c.getBoundingClientRect();
  const [x, y] = window.__scanpipe.corners[idx];
  const M = 34;                                    // must match MARGIN in ui.html
  const s = (c.width - 2*M) / window.__scanpipe.page.width, d = r.width / c.width;
  return { x: r.left + (x * s + M) * d, y: r.top + (y * s + M) * d };
}, i);
/** Pixel signature of the live preview, so "did it update" is verifiable. */
const previewSig = (page) => page.evaluate(() => {
  const im = document.querySelector('[data-testid=preview]');
  if (!im.naturalWidth) return null;
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  c.getContext('2d').drawImage(im, 0, 0, 32, 32);
  return c.getContext('2d').getImageData(0, 0, 32, 32).data.join(',');
});
const goToPage = async (page, id) => {
  await page.goto(BASE + '/?page=' + encodeURIComponent(id));
  await expect(page.getByTestId('page-title')).toHaveText(id);
  await expect.poll(() => previewSig(page), { timeout: 10000 }).not.toBeNull();
};

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => resetPipeline());

test('queue loads real scans and suggests a paper format', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByTestId('queue-count')).toContainText('pending');
  const fmts = await page.evaluate(async () => {
    const q = await (await fetch('/api/queue')).json();
    return Object.fromEntries(q.pending.map(p => [p.id, p.format]));
  });
  expect(fmts['scan-001.png']).toBe('A4');
  expect(fmts['scan-002.png']).toBe('A6');
});

test('live preview renders the deskewed result', async ({ page }) => {
  await goToPage(page, 'letter-01.png');
  const w = await page.evaluate(() => document.querySelector('[data-testid=preview]').naturalWidth);
  expect(w).toBeGreaterThan(100);
});

test('preview updates when a corner is dragged', async ({ page }) => {
  await goToPage(page, 'letter-01.png');
  const before = await previewSig(page);
  const h = await handlePos(page, 0);
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h.x + 90, h.y + 70, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => previewSig(page), { timeout: 10000 }).not.toBe(before);
});

test('deskew slider rotates the quad and is one undo step', async ({ page }) => {
  await goToPage(page, 'letter-01.png');
  const before = await page.evaluate(() => window.__scanpipe.corners.map(c => [...c]));

  // Drive the real range input the way a user would, then let it settle.
  await page.getByTestId('skew-slider').fill('3.5');
  await page.getByTestId('skew-slider').dispatchEvent('change');
  await expect(page.getByTestId('manualskew')).toHaveText('3.50°');

  const after = await page.evaluate(() => window.__scanpipe.corners.map(c => [...c]));
  const moved = Math.max(...after.map((c, i) => Math.hypot(c[0] - before[i][0], c[1] - before[i][1])));
  expect(moved).toBeGreaterThan(20);              // 3.5 deg on an A4 quad is large

  // A whole slider gesture collapses to a single undo entry.
  await page.getByTestId('btn-undo').click();
  await expect(page.getByTestId('manualskew')).toHaveText('0.00°');
  const reverted = await page.evaluate(() => window.__scanpipe.corners.map(c => [...c]));
  const drift = Math.max(...reverted.map((c, i) => Math.hypot(c[0] - before[i][0], c[1] - before[i][1])));
  expect(drift).toBeLessThan(0.001);
  expect(await page.evaluate(() => window.__scanpipe.historyDepth)).toBe(0);
});

test('fine nudge buttons still adjust skew', async ({ page }) => {
  await goToPage(page, 'letter-01.png');
  await page.getByTestId('skew-plus-01').click();
  await expect(page.getByTestId('manualskew')).toHaveText('0.10°');
  await page.getByTestId('skew-minus-01').click();
  await page.getByTestId('skew-minus-01').click();
  await expect(page.getByTestId('manualskew')).toHaveText('-0.10°');
  // The slider tracks the value, so the two controls stay consistent.
  expect(await page.getByTestId('skew-slider').inputValue()).toBe('-0.1');
});

test('gridlines are drawn over the preview and can be toggled off', async ({ page }) => {
  await goToPage(page, 'letter-01.png');
  const painted = () => page.evaluate(() => {
    const g = document.querySelector('[data-testid=grid]');
    if (!g.width || !g.height) return -1;
    const d = g.getContext('2d').getImageData(0, 0, g.width, g.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;                                     // non-transparent pixels
  });
  await expect.poll(painted, { timeout: 10000 }).toBeGreaterThan(500);

  await page.getByTestId('grid-toggle').uncheck();
  await expect.poll(painted, { timeout: 5000 }).toBe(0);

  await page.getByTestId('grid-toggle').check();
  await expect.poll(painted, { timeout: 5000 }).toBeGreaterThan(500);
});

test('dragging a side moves that edge only, perpendicular to itself', async ({ page }) => {
  await goToPage(page, 'letter-01.png');
  const before = await page.evaluate(() => window.__scanpipe.corners.map(c => [...c]));

  // Midpoint of the right-hand edge (corners 1->2), in screen coordinates.
  const mid = await page.evaluate(() => {
    const c = document.getElementById('cv'), r = c.getBoundingClientRect();
    const M = 34, s = (c.width - 2*M) / window.__scanpipe.page.width, d = r.width / c.width;
    const [a, b] = [window.__scanpipe.corners[1], window.__scanpipe.corners[2]];
    const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
    return { x: r.left + (x * s + M) * d, y: r.top + (y * s + M) * d };
  });

  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x - 80, mid.y, { steps: 12 });   // crop the right side in
  await page.mouse.up();

  const after = await page.evaluate(() => window.__scanpipe.corners.map(c => [...c]));
  const moved = after.map((c, i) => Math.hypot(c[0]-before[i][0], c[1]-before[i][1]));
  // Corners 1 and 2 form the dragged edge; 0 and 3 must be untouched.
  expect(moved[1]).toBeGreaterThan(20);
  expect(moved[2]).toBeGreaterThan(20);
  expect(moved[0]).toBeLessThan(0.001);
  expect(moved[3]).toBeLessThan(0.001);
  // Parallel: both endpoints shifted by the same amount.
  expect(Math.abs(moved[1] - moved[2])).toBeLessThan(0.001);

  // And it is a single undo step.
  await page.getByTestId('btn-undo').click();
  const reverted = await page.evaluate(() => window.__scanpipe.corners.map(c => [...c]));
  const drift = Math.max(...reverted.map((c, i) => Math.hypot(c[0]-before[i][0], c[1]-before[i][1])));
  expect(drift).toBeLessThan(0.001);
});

test('undo reverts a corner drag', async ({ page }) => {
  await goToPage(page, 'letter-01.png');
  const before = await page.evaluate(() => window.__scanpipe.corners.map(c => [...c]));
  const h = await handlePos(page, 2);
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h.x - 100, h.y - 80, { steps: 10 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => window.__scanpipe.corners.map(c => [...c]));
  expect(Math.hypot(dragged[2][0] - before[2][0], dragged[2][1] - before[2][1])).toBeGreaterThan(20);

  await page.getByTestId('btn-undo').click();
  const reverted = await page.evaluate(() => window.__scanpipe.corners.map(c => [...c]));
  const drift = Math.max(...reverted.map((c, i) => Math.hypot(c[0] - before[i][0], c[1] - before[i][1])));
  expect(drift).toBeLessThan(0.001);
});

test('locking A4 pins the output to the true ISO size regardless of the quad', async ({ page }) => {
  await goToPage(page, 'letter-01.png');
  await page.getByTestId('format').selectOption('A4');
  await expect(page.getByTestId('outdims')).toContainText('1654×2339');

  // Distort the quad; a locked format must still yield exactly A4.
  const h = await handlePos(page, 2);
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h.x - 120, h.y - 90, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('outdims')).toContainText('1654×2339');

  await page.getByTestId('btn-accept').click();
  await expect(page.getByTestId('status')).toContainText('accepted 1654×2339 (A4)');
});

test('A6 accepts at the true A6 landscape size, fully deskewed', async ({ page }) => {
  // Navigate explicitly rather than relying on queue order: other scans may be
  // pending and the order would then decide which page this test lands on.
  await goToPage(page, 'scan-002.png');
  await page.getByTestId('format').selectOption('A6');
  await expect(page.getByTestId('outdims')).toContainText('1165×827');
  await page.getByTestId('btn-accept').click();
  await expect(page.getByTestId('status')).toContainText('accepted 1165×827 (A6)');

  const out = path.join(ROOT, 'work', 'scan-002.png.page.png');
  expect(fs.existsSync(out)).toBeTruthy();
  const dims = execFileSync('./.venv/bin/python',
    ['-c', 'from PIL import Image;im=Image.open("work/scan-002.png.page.png");print(im.width,im.height)'],
    { cwd: ROOT }).toString().trim();
  expect(dims).toBe('1165 827');                            // exact ISO A6 landscape at 200dpi
});

test('finalize delivers a PDF to the paperless mock, in order', async ({ page }) => {
  await page.goto(BASE);
  await page.getByTestId('btn-finalize').click();
  await expect(page.getByTestId('status')).toContainText('sent');
  const recs = deliveries();
  expect(recs.length).toBe(1);
  // Order must match approval order; contents depend on what this run accepted.
  expect(recs[0].page_ids).toEqual(['letter-01.png', 'scan-002.png']);
  const pdf = path.join(ROOT, 'mock-paperless', 'consume', recs[0].file);
  expect(fs.readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
  expect(execFileSync('qpdf', ['--show-npages', pdf]).toString().trim()).toBe('2');
});


test.describe('ground truth and scanner hints', () => {
  test.describe.configure({ mode: 'serial' });

  // Push fixtures through the same endpoint the Pi uses, so the test exercises
  // the real ingest path rather than dropping files into the spool.
  const push = async (request, srcName, asName, hint) => {
    const body = fs.readFileSync(path.join(ROOT, 'originals', srcName));
    const r = await request.post('/api/ingest', {
      multipart: {
        file: { name: asName, mimeType: 'image/png', buffer: body },
        hint,
      },
    });
    expect(r.ok()).toBeTruthy();
    return r.json();
  };

  test.beforeAll(async ({ playwright }) => {
    resetPipeline();
    for (const f of fs.readdirSync(path.join(ROOT, 'spool'))) {
      if (f.startsWith('t-')) fs.unlinkSync(path.join(ROOT, 'spool', f));
    }
    const creds = Object.fromEntries(fs.readFileSync(path.join(ROOT, 'secrets.env'), 'utf8')
      .split('\n').filter(Boolean).map(l => l.split('=')));
    const request = await playwright.request.newContext({
      baseURL: BASE,
      httpCredentials: { username: creds.SCANPIPE_USER, password: creds.SCANPIPE_PASS },
    });
    // scan-002 really is A6; label one copy correctly and one A4 on purpose.
    await push(request, 'scan-002.png', 't-agree.png', 'A6');
    await push(request, 'scan-002.png', 't-mismatch.png', 'A4');
    await request.dispose();
  });

  test('a pushed scan reaches the queue with its hint intact', async ({ page }) => {
    await page.goto(BASE);
    const rows = await page.evaluate(async () => {
      const q = await (await fetch('/api/queue')).json();
      return Object.fromEntries(q.pending.map(p => [p.id, {h: p.hint, d: p.format, a: p.hint_agrees}]));
    });
    expect(rows['t-agree.png']).toEqual({ h: 'A6', d: 'A6', a: true });
    expect(rows['t-mismatch.png']).toEqual({ h: 'A4', d: 'A6', a: false });
  });

  test('the UI shows the hint and flags disagreement', async ({ page }) => {
    await goToPage(page, 't-agree.png');
    await expect(page.getByTestId('hint')).toHaveText('A6');
    await expect(page.getByTestId('detected')).toHaveText('A6');
    await expect(page.getByTestId('hint-mismatch')).toBeHidden();

    // Accept it UNCHANGED - agreement is evidence too.
    await page.getByTestId('btn-accept').click();
    await expect(page.getByTestId('status')).toContainText('accepted');

    await goToPage(page, 't-mismatch.png');
    await expect(page.getByTestId('hint')).toHaveText('A4');
    await expect(page.getByTestId('detected')).toHaveText('A6');
    await expect(page.getByTestId('hint-mismatch')).toBeVisible();
  });

  test('ground truth records both an untouched accept and a corrected one', async ({ page }) => {
    // The untouched accept came from the previous test.
    const clean = truthRecord('t-agree.png');
    expect(clean).not.toBeNull();
    expect(clean.hint).toBe('A6');
    expect(clean.detected.corners).not.toBeNull();
    expect(clean.accepted.corners).not.toBeNull();
    expect(clean.corner_shift_px).toBeLessThan(2);        // human changed nothing

    // Now correct one by dragging, and confirm the record captures the delta.
    await goToPage(page, 't-mismatch.png');
    const h = await handlePos(page, 2);
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    await page.mouse.move(h.x - 110, h.y - 90, { steps: 12 });
    await page.mouse.up();
    await page.getByTestId('btn-accept').click();
    await expect(page.getByTestId('status')).toContainText('accepted');

    const fixed = truthRecord('t-mismatch.png');
    expect(fixed).not.toBeNull();
    expect(fixed.corner_shift_px).toBeGreaterThan(20);    // the correction is recorded
    expect(fixed.hint).toBe('A4');
    expect(fixed.detected.format).toBe('A6');
    // Detection must be the ORIGINAL proposal, not overwritten by the edit.
    expect(fixed.detected.corners).not.toEqual(fixed.accepted.corners);
  });

  test('evaluate.py summarises the collected records', async () => {
    const out = execFileSync('./.venv/bin/python', ['evaluate.py'], { cwd: ROOT }).toString();
    expect(out).toMatch(/ground-truth records: 2/);
    expect(out).toMatch(/accepted unchanged\s*:\s*1/);
    expect(out).toMatch(/corrected by hand\s*:\s*1/);
    expect(out).toMatch(/skew error/);
  });
});


test.describe('ingest safety', () => {
  test('a same-named scan with different content never overwrites the first', async ({ playwright }) => {
    const creds = Object.fromEntries(fs.readFileSync(path.join(ROOT, 'secrets.env'), 'utf8')
      .split('\n').filter(Boolean).map(l => l.split('=')));
    const request = await playwright.request.newContext({
      baseURL: BASE,
      httpCredentials: { username: creds.SCANPIPE_USER, password: creds.SCANPIPE_PASS },
    });
    const send = async (src, name) => {
      const r = await request.post('/api/ingest', { multipart: {
        file: { name, mimeType: 'image/png',
                buffer: fs.readFileSync(path.join(ROOT, 'originals', src)) } } });
      expect(r.ok()).toBeTruthy();
      return r.json();
    };

    const a = await send('scan-002.png', 'clash.png');
    expect(a.duplicate).toBe(false);
    // Re-pushing the identical file must not create a second copy.
    const again = await send('scan-002.png', 'clash.png');
    expect(again.duplicate).toBe(true);
    expect(again.stored).toBe('clash.png');
    // Different content under the same name must be kept, not silently replace it.
    const b = await send('scan-001.png', 'clash.png');
    expect(b.duplicate).toBe(false);
    expect(b.stored).not.toBe('clash.png');

    const first = path.join(ROOT, 'spool', 'clash.png');
    const second = path.join(ROOT, 'spool', b.stored);
    expect(fs.existsSync(first)).toBeTruthy();
    expect(fs.existsSync(second)).toBeTruthy();
    expect(fs.statSync(first).size).not.toBe(fs.statSync(second).size);

    for (const f of [first, second]) fs.unlinkSync(f);
    await request.dispose();
  });
});
