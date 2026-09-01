/* Parity check: ui.js's largestInside must agree with fit.py.
 *
 * The algorithm exists twice on purpose -- the dial re-fits on every change and
 * cannot afford a round trip, while the server seeds independently and freezes
 * that seed for ground truth -- so the two implementations have to be held
 * together by something. This extracts the real functions out of ui.js (rather
 * than a copy that could drift) and compares against values produced by fit.py.
 *
 * Usage: node tests/fit_parity.mjs <cases.json>
 * where cases.json is [{quad, ratio, angle, expect:{cx,cy,w,h}}, ...]
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');

// Pull the three functions out by name. If a rename breaks this, the check
// fails loudly rather than silently testing nothing.
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`ui.js no longer defines ${name}()`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

const fns = ['inwardEdges', 'clipHalfPlane', 'largestInside'].map(extract).join('\n');
const largestInside = new Function(`${fns}; return largestInside;`)();

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let worst = 0;
for (const c of cases) {
  const got = largestInside(c.quad, c.ratio, c.angle);
  if (!got !== !c.expect) {
    console.error(`MISMATCH null-ness at angle ${c.angle}`);
    process.exit(1);
  }
  if (!got) continue;
  for (const k of ['cx', 'cy', 'w', 'h']) {
    worst = Math.max(worst, Math.abs(got[k] - c.expect[k]));
  }
}
console.log(`largest divergence from fit.py: ${worst.toExponential(3)} px`);
// A thousandth of a pixel: both sides do the same 50 bisection steps in
// doubles, so anything larger means the implementations have actually drifted.
process.exit(worst < 1e-3 ? 0 : 1);
