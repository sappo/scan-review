/** Return the review queue to a known state.
 *
 * Tests accept and reject pages, which consumes the queue. Run once per suite
 * this is not enough: the second project would find an empty queue, and tests
 * would depend on what earlier tests happened to leave behind. So this runs
 * before EVERY test, which also makes each test independent of run order.
 *
 * Pages are removed from state entirely rather than flipped back to pending, so
 * `refresh()` re-ingests them from the spool and regenerates `detected` and
 * `seeded` exactly as a real ingest would. The spool files are never touched;
 * accept() only ever reads them.
 *
 * Writing state.json directly is safe here only because the server holds its
 * lock for the duration of a request and Playwright runs one worker with no
 * request in flight at this point. Do not call this concurrently with traffic.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'work', 'state.json');
const TRUTH = path.join(ROOT, 'groundtruth');
const CONSUME = path.join(ROOT, 'mock-paperless', 'consume');

function reset() {
  if (fs.existsSync(STATE)) {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    for (const [id, page] of Object.entries(s.pages)) {
      // Drop anything consumed so it re-ingests, and anything whose spool file
      // is gone so a stale entry cannot 410 the whole suite.
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
}

module.exports = reset;
module.exports.reset = reset;
