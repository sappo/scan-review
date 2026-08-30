/** Return the review queue to a known state before a test run.
 *
 * Tests accept and reject pages, which consumes the queue. Without this the
 * suite passes once and then fails for want of pending pages - a test that only
 * works on a fresh checkout is not a test.
 *
 * Pages are removed from state entirely rather than flipped back to pending, so
 * `refresh()` re-ingests them from the spool and regenerates `detected` and
 * `seeded` exactly as a real ingest would. The spool files themselves are never
 * touched; accept() only ever reads them.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'work', 'state.json');
const TRUTH = path.join(ROOT, 'groundtruth');
const CONSUME = path.join(ROOT, 'mock-paperless', 'consume');

module.exports = async () => {
  if (fs.existsSync(STATE)) {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    for (const [id, page] of Object.entries(s.pages)) {
      // Drop anything whose spool file is still there so it re-ingests, and
      // anything whose file is gone so it cannot 410 the whole suite.
      if (page.status !== 'pending' || !fs.existsSync(page.source)) {
        delete s.pages[id];
        s.ingested = s.ingested.filter(k => k !== id);
      }
    }
    s.document = [];
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  }
  for (const dir of [TRUTH, CONSUME]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json') || f.endsWith('.pdf')) fs.unlinkSync(path.join(dir, f));
    }
  }
};
