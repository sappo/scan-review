/** Take the generated fixtures back out of the queue when the suite finishes.
 *
 * The suite runs against the live service, so its documents land in the same
 * queue as real scans pushed by the Pi. Leaving them there means opening the UI
 * after a test run and finding four synthetic documents to step past.
 *
 * Only `fx-` documents are touched. Anything the Pi pushed is left alone -
 * see the `fixtures()` helper in pipeline.spec.js, which is what keeps the
 * tests themselves off real data.
 *
 * The next run regenerates them: globalSetup's ensureFixtures recreates any
 * missing fixture before the first test.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'work', 'state.json');
const FIXTURE = /^fx-/;

function rmMatching(dir, matches) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!matches(f)) continue;
    fs.unlinkSync(path.join(dir, f));
    n++;
  }
  return n;
}

module.exports = async () => {
  if (fs.existsSync(STATE)) {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    for (const id of Object.keys(s.pages || {})) {
      if (FIXTURE.test(id)) delete s.pages[id];
    }
    s.ingested = (s.ingested || []).filter(id => !FIXTURE.test(id));
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  }
  // The scans themselves, their hint sidecars, their thumbnails, and the
  // ground-truth records the run wrote for them.
  const scans = rmMatching(path.join(ROOT, 'spool'), f => FIXTURE.test(f));
  rmMatching(path.join(ROOT, 'spool-archive'), f => FIXTURE.test(f));
  rmMatching(path.join(ROOT, 'work', 'thumbs'), f => FIXTURE.test(f));
  rmMatching(path.join(ROOT, 'groundtruth'), f => FIXTURE.test(f));
  console.log(`teardown: removed ${scans} fixture scans from the queue`);
};
