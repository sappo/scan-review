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
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'work', 'state.json');
const TRUTH = path.join(ROOT, 'groundtruth');
const CONSUME = path.join(ROOT, 'mock-paperless', 'consume');

/** The suite supplies its own scans. It used to run against real documents in
 *  spool/, which are not in the repository and were consumed as the tests ran,
 *  so it only worked on one machine and only until the queue emptied. */
const FIXTURE_COUNT = 5;
/** Same prefix teardown-queue.js uses. Anything not matching it belongs to the
 *  operator, not to this suite, and must survive a test run. */
const FIXTURE = /^fx-/;

function ensureFixtures() {
  const spool = path.join(ROOT, 'spool');
  // Deleting a document MOVES its scans to spool-archive, so a fixture can
  // leave the spool during a run. Checking merely that some fx- file exists let
  // the set shrink permanently and starved later tests of documents.
  const archive = path.join(ROOT, 'spool-archive');
  if (fs.existsSync(archive))
    for (const f of fs.readdirSync(archive))
      if (f.startsWith('fx-')) fs.unlinkSync(path.join(archive, f));
  const have = fs.existsSync(spool)
    ? fs.readdirSync(spool).filter(f => f.startsWith('fx-') && f.endsWith('.png')).length
    : 0;
  if (have >= FIXTURE_COUNT) return;
  execFileSync(path.join(ROOT, '.venv', 'bin', 'python'),
               [path.join(ROOT, 'make_fixtures.py'), spool], { stdio: 'inherit' });
}

function reset() {
  ensureFixtures();
  if (fs.existsSync(STATE)) {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    for (const [id, page] of Object.entries(s.pages)) {
      if (!fs.existsSync(page.source)) {
        // Deleted documents have their scans moved to spool-archive. Drop the
        // entry so it re-ingests once ensureFixtures puts the file back.
        delete s.pages[id];
        s.ingested = s.ingested.filter(k => k !== id);
        continue;
      }
      // Restore in place rather than deleting and re-ingesting. Re-ingest costs
      // ~195ms of detection and deskew per page, and it reassigns ingest order,
      // which is what documents are sorted by - so document order shifted
      // between runs and tests that searched positionally landed elsewhere.
      // `detected` and `seeded` are frozen at ingest, so keeping them is also
      // more faithful than regenerating them.
      page.status = 'pending';
      for (const k of ['output', 'out_width', 'out_height', 'outside']) delete page[k];
    }
    delete s.documents;    // removed: staged membership is a page status now
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  }
  const thumbs = path.join(ROOT, 'work', 'thumbs');
  if (fs.existsSync(thumbs))
    for (const f of fs.readdirSync(thumbs)) fs.unlinkSync(path.join(thumbs, f));
  // ONLY this suite's own records. This used to delete every .json in
  // groundtruth/, so a single test run destroyed the entire ground-truth
  // corpus - the thing the accept/seed/error apparatus exists to accumulate,
  // and which cannot be reconstructed once gone. teardown-queue.js always
  // filtered on the fixture prefix; this did not, and it runs before EVERY
  // test rather than once per suite.
  //
  // The two directories need different rules. A ground-truth record is named
  // after its page (fx-letter-...png.json), so it starts with the prefix. A
  // delivered PDF is document-<stamp>-<batch>.pdf, so the prefix is in the
  // MIDDLE - matching on ^fx- there would quietly stop cleaning them and let
  // them pile up run after run.
  const mine = { [TRUTH]: f => FIXTURE.test(f),
                 [CONSUME]: f => f.includes('-fx-') };
  for (const dir of [TRUTH, CONSUME]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!mine[dir](f)) continue;
      if (f.endsWith('.json') || f.endsWith('.pdf')) fs.unlinkSync(path.join(dir, f));
    }
  }
}

module.exports = reset;
module.exports.reset = reset;
