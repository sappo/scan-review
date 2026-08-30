# Document Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the review queue from a flat list of pages into a list of documents, each carrying its pages, with document-level navigation, a page filmstrip, and reversible decisions.

**Architecture:** A new pure module `documents.py` assembles the queue from `state`, so grouping, ordering and label formatting are unit-testable without a browser or a server. `app.py` gains a `sent` page status, a reopen endpoint and a thumbnail endpoint, and loses `state["documents"]` — staged membership becomes derivable from page status. `ui.js` navigates documents and renders a filmstrip of the current document's pages.

**Tech Stack:** Python 3 / FastAPI / OpenCV / numpy (backend, `.venv`), vanilla JS + Canvas 2D (frontend, no build step), Playwright (e2e), pytest (units).

**Spec:** `docs/superpowers/specs/2026-08-31-document-queue-design.md`

## Global Constraints

- Page status is one of exactly `pending`, `accepted`, `rejected`, `sent`.
- A document appears in the queue only while it has ≥1 page that is `pending` or `accepted`.
- Documents are ordered by arrival: the lowest index in `state["ingested"]` among that batch's pages. **Never by batch id** — a manual `adf-scan report` run has no timestamp in its name.
- Pages within a document are ordered by `page_no`, tie-broken by `id`.
- `ready` means `counts.pending == 0`; `finalize` refuses with 409 unless ready.
- Reopen refuses with 409 on a `sent` page. That is the only irreversible point.
- The server must stay single-process; `state.json` is read-modify-written under `_lock` and `save_state()` must remain atomic.
- Playwright runs with `workers: 1`; the queue is reset before every test.
- Use `./.venv/bin/python`, never `python3`.
- Restart after backend changes: `systemctl --user restart scanpipe`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `documents.py` | Group pages into documents: ordering, counts, `ready`, labels | **create** |
| `tests/test_documents.py` | Units for the above | **create** |
| `app.py` | `sent` status, `/api/reopen`, `/api/thumb`, queue payload, finalize | modify |
| `ui.html` | Filmstrip markup and styles | modify |
| `ui.js` | Document navigation, filmstrip, auto-advance, reopen | modify |
| `tests/pipeline.spec.js` | 12 references to `pending` to update; new coverage | modify |
| `tests/reset-queue.js` | Clear `work/thumbs/`; drop the `documents` key | modify |
| `README.md` | Describe the two-level queue | modify |

---

### Task 1: `documents.py` — grouping and ordering

**Files:**
- Create: `documents.py`
- Create: `tests/test_documents.py`

**Interfaces:**
- Produces:
  - `label_for(batch: str) -> str`
  - `build(state: dict) -> list[dict]` returning documents shaped
    `{batch, label, ready, counts: {total, pending, accepted, rejected}, pages: [page, ...]}`
  - `ACTIVE = ("pending", "accepted")`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_documents.py`:

```python
import documents as D


def page(pid, batch, page_no, status="pending"):
    return {"id": pid, "batch": batch, "page_no": page_no, "status": status}


def state(*pages):
    """Pages in the order they were ingested."""
    return {"pages": {p["id"]: p for p in pages},
            "ingested": [p["id"] for p in pages]}


def test_pages_are_grouped_by_batch_and_ordered_by_page_number():
    docs = D.build(state(page("b-02.png", "b", 2), page("b-01.png", "b", 1)))
    assert [d["batch"] for d in docs] == ["b"]
    assert [p["id"] for p in docs[0]["pages"]] == ["b-01.png", "b-02.png"]


def test_documents_are_ordered_by_arrival_not_by_batch_id():
    # "zz" arrived first, so it comes first even though "aa" sorts before it.
    docs = D.build(state(page("zz-01.png", "zz", 1), page("aa-01.png", "aa", 1)))
    assert [d["batch"] for d in docs] == ["zz", "aa"]


def test_counts_and_ready_across_a_mixed_document():
    docs = D.build(state(page("b-01.png", "b", 1, "accepted"),
                         page("b-02.png", "b", 2, "rejected"),
                         page("b-03.png", "b", 3, "pending")))
    d = docs[0]
    assert d["counts"] == {"total": 3, "pending": 1, "accepted": 1, "rejected": 1}
    assert d["ready"] is False


def test_ready_when_nothing_is_pending():
    docs = D.build(state(page("b-01.png", "b", 1, "accepted"),
                         page("b-02.png", "b", 2, "rejected")))
    assert docs[0]["ready"] is True


def test_a_sent_document_leaves_the_queue():
    docs = D.build(state(page("b-01.png", "b", 1, "sent"),
                         page("b-02.png", "b", 2, "rejected")))
    assert docs == []


def test_a_wholly_rejected_document_leaves_the_queue():
    # Nothing left to send, so there is nothing to review either.
    docs = D.build(state(page("b-01.png", "b", 1, "rejected")))
    assert docs == []


def test_a_document_with_one_live_page_stays():
    docs = D.build(state(page("b-01.png", "b", 1, "sent"),
                         page("b-02.png", "b", 2, "pending")))
    assert [d["batch"] for d in docs] == ["b"]
    # Sent pages are still listed, so the filmstrip shows the whole document.
    assert len(docs[0]["pages"]) == 2


def test_label_formats_a_scanui_batch():
    assert D.label_for("a4-20260831-101500") == "A4 · 31 Aug 10:15"


def test_label_passes_through_anything_else():
    # A manual `adf-scan report` run has no timestamp; inventing one would lie.
    assert D.label_for("report") == "report"
    assert D.label_for("a4-nonsense") == "a4-nonsense"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/test_documents.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'documents'`.

- [ ] **Step 3: Write `documents.py`**

```python
"""Assemble the review queue as documents, not pages.

One ADF run is one document (see the batch work in
docs/superpowers/specs/2026-08-30-mobile-review-ui-design.md). The operator
thinks in documents, so the queue is shaped that way and the UI does not have
to reconstruct the grouping on every load.

Pure functions over `state`: no FastAPI, no filesystem, so the ordering and
label rules can be tested without a browser or a running server.
"""
import re
from datetime import datetime

# A document is worth showing while it still has a page that could end up in a
# PDF. Once every page is sent or rejected there is nothing left to decide.
ACTIVE = ("pending", "accepted")

# What scanui.py produces: <size>-<YYYYmmdd>-<HHMMSS>.
BATCH_NAME = re.compile(r"^(?P<size>[A-Za-z0-9]+)-(?P<d>\d{8})-(?P<t>\d{6})$")


def label_for(batch):
    """A human label for a batch id, or the id itself.

    Manual `adf-scan report` runs have no timestamp in the name. Passing those
    through unchanged is better than inventing a date for them.
    """
    m = BATCH_NAME.match(batch or "")
    if not m:
        return batch
    try:
        when = datetime.strptime(m.group("d") + m.group("t"), "%Y%m%d%H%M%S")
    except ValueError:
        return batch
    return f"{m.group('size').upper()} · {when:%-d %b %H:%M}"


def build(state):
    """The queue: documents in arrival order, each with its pages."""
    pages = state.get("pages", {})
    order = {pid: i for i, pid in enumerate(state.get("ingested", []))}
    groups = {}
    for pid, page in pages.items():
        groups.setdefault(page.get("batch") or pid, []).append(page)

    docs = []
    for batch, members in groups.items():
        if not any(p.get("status") in ACTIVE for p in members):
            continue
        members.sort(key=lambda p: (p.get("page_no") or 0, p["id"]))
        counts = {"total": len(members)}
        for st in ("pending", "accepted", "rejected"):
            counts[st] = sum(1 for p in members if p.get("status") == st)
        docs.append({
            "batch": batch,
            "label": label_for(batch),
            "ready": counts["pending"] == 0,
            "counts": counts,
            "pages": members,
            # Arrival order of the document is that of its earliest page.
            "_at": min(order.get(p["id"], 1 << 30) for p in members),
        })
    docs.sort(key=lambda d: d["_at"])
    for d in docs:
        d.pop("_at")
    return docs
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/test_documents.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add documents.py tests/test_documents.py
git commit -m "feat: assemble the queue as documents rather than pages

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Queue payload, and delete `state["documents"]`

**Files:**
- Modify: `app.py` — `load_state()`, `queue()` (~line 287), `accept()` (~line 305), `finalize()` (~line 466)
- Modify: `tests/reset-queue.js`
- Modify: `tests/pipeline.spec.js`

**Interfaces:**
- Consumes: `documents.build` (Task 1)
- Produces: `GET /api/queue` → `{"documents": [...]}`; `pending` and the top-level `documents` map are both gone.

- [ ] **Step 1: Write the failing test**

Replace the first test in `tests/pipeline.spec.js` (`queue seeds a ratio-locked frame for every pending page`) with:

```javascript
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
      // Pages in scan order.
      const nos = d.pages.map(p => p.page_no);
      expect(nos).toEqual([...nos].sort((a, b) => a - b));
      // All of one document's pages share its batch.
      expect(new Set(d.pages.map(p => p.batch))).toEqual(new Set([d.batch]));
    }
  });

test('queue seeds a ratio-locked frame for every page', async ({ request }) => {
  const pages = await allPages(request);
  expect(pages.length).toBeGreaterThan(0);
  const RATIO = { A4: 297 / 210, A5: 210 / 148, A6: 148 / 105 };
  for (const p of pages) {
    expect(p.seeded, `page ${p.id} has no seeded frame`).toBeTruthy();
    const { w, h, format, orientation } = p.seeded;
    const want = orientation === 'landscape' ? 1 / RATIO[format] : RATIO[format];
    expect(h / w).toBeCloseTo(want, 9);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "a list of documents"`
Expected: FAIL — the payload still has `pending`.

- [ ] **Step 3: Change `app.py`**

Add the import beside the others:

```python
import documents as documents_mod
```

Replace `queue()`:

```python
@app.get("/api/queue")
def queue():
    s, _ = refresh()
    return {"documents": documents_mod.build(s)}
```

In `load_state()`, drop the `documents` default and stop carrying it:

```python
    if STATE.exists():
        s = json.loads(STATE.read_text())
        s.setdefault("pages", {})
        s.setdefault("ingested", [])
        # `documents` used to map batch -> staged page ids. Staged membership is
        # derivable from page status, and keeping both in step cost a bug once.
        s.pop("documents", None)
        return s
```

and in the fresh-state branch:

```python
    return {"pages": {}, "ingested": []}
```

In `accept()`, delete the line that stages the page:

```python
        s["documents"].setdefault(page["batch"], []).append(page_id)
```

In `finalize()`, replace the id collection:

```python
        ids = [i for i in (s["documents"].get(batch) or [])
               if s["pages"].get(i, {}).get("output")]
```

with:

```python
        members = [p for p in s["pages"].values() if p.get("batch") == batch]
        if not members:
            raise HTTPException(404, f"no such batch {batch!r}")
        if any(p["status"] == "pending" for p in members):
            # Sending half a document would produce a second PDF for the same
            # ADF run later, and one run is one document.
            raise HTTPException(409, f"batch {batch!r} still has undecided pages")
        staged = [p for p in members if p["status"] == "accepted" and p.get("output")]
        staged.sort(key=lambda p: (p.get("page_no") or 0, p["id"]))
        ids = [p["id"] for p in staged]
```

and delete the line that clears the staged list:

```python
        s["documents"].pop(batch, None)
```

replacing it with marking the pages sent:

```python
        for p in staged:
            p["status"] = "sent"
```

- [ ] **Step 4: Update the reset harness**

In `tests/reset-queue.js`, replace `s.documents = {};` with:

```javascript
    delete s.documents;     // removed: staged membership is a page status now
```

- [ ] **Step 5: Restart and run**

Run:
```bash
cd ~/projects/scanpipe && systemctl --user restart scanpipe && sleep 3
npx playwright test --project=mobile -g "a list of documents|seeds a ratio-locked"
```
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/scanpipe
git add app.py tests/reset-queue.js tests/pipeline.spec.js
git commit -m "feat: queue returns documents; staged membership is a page status

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Reopen a decided page

**Files:**
- Modify: `app.py` — new route beside `reject()` (~line 454)
- Modify: `tests/pipeline.spec.js`

**Interfaces:**
- Produces: `POST /api/reopen/{page_id}` → `{"ok": true, "status": "pending"}`; 404 unknown, 409 sent.

- [ ] **Step 1: Write the failing tests**

Append to `tests/pipeline.spec.js`:

```javascript
test('a decided page can be reopened until it is sent', async ({ request }) => {
  const pages = await allPages(request);
  const p = pages.find(x => x.status === 'pending');
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "reopened until it is sent|unknown page is a 404"`
Expected: FAIL with 405 or 404 on the reopen call.

- [ ] **Step 3: Add the route**

In `app.py`, directly after `reject()`:

```python
@app.post("/api/reopen/{page_id}")
def reopen(page_id: str):
    """Put a decided page back in play.

    Deciding is reversible right up until the document is sent - that is what
    makes the last look before Send worth having, and it is the way back from a
    mis-tap. Sending is not reversible: the PDF has been delivered.
    """
    with _lock:
        s = load_state()
        page = s["pages"].get(page_id)
        if not page:
            raise HTTPException(404, "unknown page")
        if page["status"] == "sent":
            raise HTTPException(409, "already sent")
        page["status"] = "pending"
        for key in ("output", "out_width", "out_height", "outside"):
            page.pop(key, None)
        save_state(s)
        return {"ok": True, "status": "pending"}
```

- [ ] **Step 4: Restart and run**

Run:
```bash
cd ~/projects/scanpipe && systemctl --user restart scanpipe && sleep 3
npx playwright test --project=mobile -g "reopened until it is sent|unknown page is a 404"
```
Expected: 2 passed.

- [ ] **Step 5: Add the sent-is-final test**

Append to `tests/pipeline.spec.js`:

```javascript
test('a sent page cannot be reopened, and finalize needs a decided document',
  async ({ request }) => {
    const { documents } = await (await request.get('/api/queue')).json();
    const doc = documents.find(d => d.counts.total > 1) || documents[0];

    // Undecided pages remain: finalize must refuse.
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

    // The document has left the queue and its pages are final.
    const after = await (await request.get('/api/queue')).json();
    expect(after.documents.find(d => d.batch === doc.batch)).toBeUndefined();
    const r = await request.post(`/api/reopen/${encodeURIComponent(doc.pages[0].id)}`);
    expect(r.status()).toBe(409);
  });
```

- [ ] **Step 6: Run it**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "sent page cannot be reopened"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/scanpipe
git add app.py tests/pipeline.spec.js
git commit -m "feat: reopen a decided page; sending is the only one-way door

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Thumbnails for the filmstrip

**Files:**
- Modify: `app.py` — new route beside `image()` (~line 295)
- Modify: `tests/reset-queue.js`
- Modify: `tests/pipeline.spec.js`

**Interfaces:**
- Produces: `GET /api/thumb/{page_id}` → JPEG, long side 160px, cached at `work/thumbs/{page_id}.jpg`.

- [ ] **Step 1: Write the failing test**

Append to `tests/pipeline.spec.js`:

```javascript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "thumbnails are small"`
Expected: FAIL — 404 on `/api/thumb`.

- [ ] **Step 3: Add the route**

In `app.py`, add a constant beside `WORK`:

```python
THUMBS = WORK / "thumbs"
THUMB_LONG_SIDE = 160     # displayed at 96px; 160 covers a 1.5x screen
```

and after `image()`:

```python
@app.get("/api/thumb/{page_id}")
def thumb(page_id: str):
    """A small JPEG of the RAW scan, for the filmstrip.

    Not the cropped result: the strip is an index of what is in the document,
    and rendering every page through warp() on demand would be slow and would
    shift under the operator as they drag the frame.
    """
    s = load_state()
    page = s["pages"].get(page_id)
    if not page:
        raise HTTPException(404, "unknown page")
    THUMBS.mkdir(parents=True, exist_ok=True)
    dest = THUMBS / f"{page_id}.jpg"
    if not dest.exists():
        img = cv2.imread(page["source"])
        if img is None:
            raise HTTPException(410, f"source image gone: {page['source']}")
        scale = THUMB_LONG_SIDE / max(img.shape[:2])
        small = cv2.resize(img, None, fx=scale, fy=scale,
                           interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(dest), small, [cv2.IMWRITE_JPEG_QUALITY, 75])
    return Response(content=dest.read_bytes(), media_type="image/jpeg")
```

- [ ] **Step 4: Clear thumbnails on reset**

In `tests/reset-queue.js`, inside `reset()` after the state rewrite, add:

```javascript
  const thumbs = path.join(ROOT, 'work', 'thumbs');
  if (fs.existsSync(thumbs))
    for (const f of fs.readdirSync(thumbs)) fs.unlinkSync(path.join(thumbs, f));
```

- [ ] **Step 5: Restart and run**

Run:
```bash
cd ~/projects/scanpipe && systemctl --user restart scanpipe && sleep 3
npx playwright test --project=mobile -g "thumbnails are small"
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/scanpipe
git add app.py tests/reset-queue.js tests/pipeline.spec.js
git commit -m "feat: thumbnail endpoint for the page filmstrip

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: UI — document navigation and the filmstrip

**Files:**
- Modify: `ui.html` — filmstrip markup and styles
- Modify: `ui.js` — state, `load`, `showPage`, `step`, `updateNav`, `accept`, `reject`, `finalize`
- Modify: `tests/pipeline.spec.js` — every remaining `pending` reference

**Interfaces:**
- Consumes: `GET /api/queue` (Task 2), `POST /api/reopen` (Task 3), `GET /api/thumb` (Task 4)
- Produces (globals used by tests): `state.documents` (array), `state.docIndex`, `state.pageIndex`, `currentDoc()`, `currentPage()`, `step(delta)` stepping **documents**, `selectPage(i)`, `advanceAfterDecision()`
- Produces `data-testid` hooks: `filmstrip`, `film-<index>` per page, `film-state-<index>`

- [ ] **Step 1: Add the filmstrip markup and styles**

In `ui.html`, add to the stylesheet after the `.sep` rule:

```css
  /* The pages of the current document, with their state. It is both the way
     into a page and the document's progress indicator. */
  #filmstrip { display:flex; gap:6px; padding:6px 8px; overflow-x:auto;
               max-width:calc(100vw - 20px); background:var(--float);
               border-radius:14px; backdrop-filter:blur(10px);
               box-shadow:0 4px 20px rgba(0,0,0,.45); pointer-events:auto;
               scrollbar-width:none; }
  #filmstrip::-webkit-scrollbar { display:none; }
  #filmstrip:empty { display:none; }
  /* Page-shaped and 52px wide rather than the spec's 96: five or six then fit
     a 375px screen without scrolling, which is the common case. The thumbnail
     itself stays 160px so it is sharp on a dense display. */
  .film { position:relative; flex:none; width:52px; height:68px; padding:0;
          border:2px solid transparent; border-radius:8px; overflow:hidden;
          background:#1b2028; }
  .film img { width:100%; height:100%; object-fit:cover; display:block; }
  .film[aria-current=true] { border-color:var(--accent); }
  .film[data-state=rejected] img { opacity:.35; }
  .film .mark { position:absolute; right:2px; bottom:2px; width:16px;
                height:16px; border-radius:8px; font-size:11px; line-height:16px;
                text-align:center; font-weight:700; }
  .film[data-state=accepted] .mark { background:var(--accent); color:#06121f; }
  .film[data-state=rejected] .mark { background:var(--err); color:#fff; }
```

and add the strip inside `#controls`, immediately before the flags:

```html
  <div id="filmstrip" data-testid="filmstrip"></div>
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/pipeline.spec.js`:

```javascript
test('the filmstrip shows every page of the current document with its state',
  async ({ page, request }) => {
    await ready(page);
    const doc = await page.evaluate(() => window.currentDoc());
    const films = page.locator('#filmstrip .film');
    await expect(films).toHaveCount(doc.pages.length);
    // The open page is marked current.
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
    // Find a document with more than one page.
    const total = await page.evaluate(() => window.state.documents.length);
    for (let i = 0; i < total; i++) {
      if (await page.evaluate(() => window.currentDoc().pages.length) > 1) break;
      await page.getByTestId('btn-next').click();
    }
    const before = await page.evaluate(() => window.currentPage().id);
    await page.getByTestId('btn-accept').click();
    await expect(page.getByTestId('status')).toContainText('accepted');
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
  expect(await page.evaluate(() => window.currentPage().status)).toBe('pending');
  await expect(page.locator('#filmstrip .film[data-state=rejected]')).toHaveCount(0);
});

test('deciding the last page leaves you put and lights Send', async ({ page }) => {
  await ready(page);
  const n = await page.evaluate(() => window.currentDoc().pages.length);
  for (let i = 0; i < n; i++) {
    await page.getByTestId('btn-accept').click();
    await expect(page.getByTestId('status')).toContainText('accepted');
  }
  expect(await page.evaluate(() => window.currentDoc().ready)).toBe(true);
  await expect(page.getByTestId('btn-finalize')).toBeEnabled();
  await expect(page.getByTestId('staged-count')).toHaveText(String(n));
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "filmstrip|step documents|advances to the next|lights Send"`
Expected: FAIL — `window.currentDoc is not a function`.

- [ ] **Step 4: Rewrite the navigation section of `ui.js`**

Replace the state fields:

```javascript
  pending: [], index: 0, documents: {}, lastBatch: null,
```

with:

```javascript
  documents: [], docIndex: 0, pageIndex: 0,
```

Replace `currentBatch()`, `updateStaged()`, `updateNav()`, `step()`, `showPage()` and `load()` with:

```javascript
function currentDoc() { return state.documents[state.docIndex] || null; }
function currentPage() {
  const d = currentDoc();
  return d ? d.pages[state.pageIndex] || null : null;
}
window.currentDoc = currentDoc; window.currentPage = currentPage;

function updateStaged() {
  const d = currentDoc();
  const n = d ? d.counts.accepted : 0;
  q('staged-count').textContent = n ? String(n) : '';
  // One run is one document, so a document is sent whole or not at all.
  q('btn-finalize').disabled = !d || !d.ready || n === 0;
  q('btn-finalize').title = d && d.ready && n
    ? `Send ${n} page${n === 1 ? '' : 's'} to paperless`
    : 'Decide every page first';
}
window.updateStaged = updateStaged;

function updateNav() {
  const n = state.documents.length;
  q('queue-count').textContent = n ? `${state.docIndex + 1}/${n}` : '0/0';
  q('btn-prev').disabled = state.docIndex <= 0;
  q('btn-next').disabled = state.docIndex >= n - 1;
  const d = currentDoc(), p = currentPage();
  q('page-title').textContent = d
    ? `${d.label}${d.pages.length > 1 ? ` · p${p ? p.page_no : '?'}` : ''}`
    : 'queue empty';
  for (const id of ['btn-accept', 'btn-reject']) q(id).disabled = !p;
  updateStaged();
  applyTitleState();
}

/** Step DOCUMENTS. Bounded, not wrapping: on a phone a wrap looks identical
 *  to not having moved. */
async function step(delta) {
  const next = state.docIndex + delta;
  if (next < 0 || next >= state.documents.length) return;
  captureEdit();
  state.docIndex = next;
  state.pageIndex = firstUndecided(state.documents[next]);
  await showPage();
}
window.step = step;

/** Open a page of the current document. A decided page is reopened first -
 *  that is what makes the last look before Send worth having. */
async function selectPage(i) {
  const d = currentDoc();
  if (!d || !d.pages[i]) return;
  captureEdit();
  const p = d.pages[i];
  if (p.status === 'accepted' || p.status === 'rejected') {
    const r = await fetch('/api/reopen/' + encodeURIComponent(p.id),
                          { method: 'POST' });
    if (r.ok) { state.pageIndex = i; await load(); return; }
  }
  state.pageIndex = i;
  await showPage();
}
window.selectPage = selectPage;

function firstUndecided(doc) {
  if (!doc) return 0;
  const i = doc.pages.findIndex(p => p.status === 'pending');
  return i < 0 ? 0 : i;
}

/** After a decision, go to the next undecided page of this document, scanning
 *  forward and wrapping once - pages can be decided out of order from the
 *  filmstrip, so the next one may be behind you. */
function advanceAfterDecision() {
  const d = currentDoc();
  if (!d) return;
  const n = d.pages.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.pageIndex + k) % n;
    if (d.pages[i].status === 'pending') { state.pageIndex = i; return; }
  }
}
window.advanceAfterDecision = advanceAfterDecision;

function renderFilmstrip() {
  const strip = document.getElementById('filmstrip');
  const d = currentDoc();
  strip.innerHTML = '';
  if (!d) return;
  d.pages.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'film';
    b.dataset.testid = 'film-' + i;
    b.dataset.state = p.status;
    b.setAttribute('aria-current', String(i === state.pageIndex));
    b.setAttribute('aria-label', `Page ${p.page_no}, ${p.status}`);
    b.onclick = () => selectPage(i);
    const im = document.createElement('img');
    im.src = '/api/thumb/' + encodeURIComponent(p.id);
    im.alt = '';
    b.appendChild(im);
    if (p.status === 'accepted' || p.status === 'rejected') {
      const m = document.createElement('span');
      m.className = 'mark';
      m.textContent = p.status === 'accepted' ? '✓' : '✕';
      b.appendChild(m);
    }
    strip.appendChild(b);
  });
}
window.renderFilmstrip = renderFilmstrip;

async function showPage() {
  state.peek = false;
  const p = currentPage();
  if (!p) {
    state.page = null; state.img = null; state.frame = null;
    renderFilmstrip(); updateNav(); render();
    return;
  }
  state.page = p;
  const s = p.seeded;
  const kept = state.edits[p.id];
  if (kept) {
    state.frame = { ...kept.frame }; state.format = kept.format;
    state.orientation = kept.orientation; state.rotation = kept.rotation;
  } else {
    state.frame = s
      ? { cx: s.cx, cy: s.cy, w: s.w, h: s.h, angle: s.angle }
      : { cx: p.width / 2, cy: p.height / 2, w: p.width, h: p.height, angle: 0 };
    state.format = (s && s.format) || 'A4';
    state.orientation = (s && s.orientation) || 'portrait';
    state.rotation = 0;
  }
  state.detectedAngle = s ? s.angle : 0;
  state.seedW = s ? s.w : state.frame.w;
  state.history = [];
  state.view = { zoom: 1, panX: 0, panY: 0 };
  q('angle-readout').textContent =
      `${dialValue() >= 0 ? '+' : ''}${dialValue().toFixed(2)}°`;
  await new Promise(res => {
    const im = new Image();
    im.onload = () => { state.img = im; res(); };
    im.onerror = () => res();
    im.src = '/api/image/' + encodeURIComponent(p.id) + '?t=' + Date.now();
  });
  syncChips();
  renderFilmstrip();
  updateNav();
  resize();
}
window.showPage = showPage;

async function load() {
  const r = await fetch('/api/queue');
  const data = await r.json();
  state.documents = data.documents || [];
  state.docIndex = Math.max(0, Math.min(state.docIndex,
                                        state.documents.length - 1));
  const d = currentDoc();
  if (!d || state.pageIndex >= d.pages.length) {
    state.pageIndex = firstUndecided(d);
  }
  await showPage();
}
```

- [ ] **Step 5: Point accept, reject and finalize at the document**

Replace the tail of `accept()`:

```javascript
  say(`accepted ${out.width}×${out.height}`, 'var(--accent)');
  state.lastBatch = state.page.batch;
  delete state.edits[state.page.id];
  await load();
```

with:

```javascript
  say(`accepted ${out.width}×${out.height}`, 'var(--accent)');
  delete state.edits[state.page.id];
  await load();
  advanceAfterDecision();
  await showPage();
```

Replace the tail of `reject()`:

```javascript
  say('rejected');
  delete state.edits[state.page.id];
  await load();
```

with:

```javascript
  say('rejected');
  delete state.edits[state.page.id];
  await load();
  advanceAfterDecision();
  await showPage();
```

Replace `finalize()`:

```javascript
async function finalize() {
  const d = currentDoc();
  if (!d || !d.ready) { say('decide every page first', 'var(--err)'); return; }
  const r = await fetch('/api/finalize/' + encodeURIComponent(d.batch),
                        { method: 'POST' });
  if (!r.ok) { say('nothing to send', 'var(--err)'); return; }
  const out = await r.json();
  say(`sent to paperless: ${out.pages} page(s)`, 'var(--accent)');
  state.pageIndex = 0;
  await load();
}
```

- [ ] **Step 6: Run the new tests**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "filmstrip|step documents|advances to the next|lights Send|reopens it"`
Expected: 5 passed.

- [ ] **Step 7: Fix the remaining `pending` references**

Run: `cd ~/projects/scanpipe && grep -n "pending" tests/pipeline.spec.js`

There are 12 hits. Three mechanical rules, with a worked example of each:

1. Reading the list. Before:

```javascript
const { pending } = await (await request.get('/api/queue')).json();
const p = pending.find(x => x.seeded);
```

after:

```javascript
const p = (await allPages(request)).find(x => x.seeded);
```

2. Asserting a page has left the queue. Before:

```javascript
const { pending } = await (await request.get('/api/queue')).json();
expect(pending.find(p => p.id === id)).toBeUndefined();
```

after:

```javascript
const page = (await allPages(request)).find(p => p.id === id);
expect(page.status).not.toBe('pending');   // it is decided, not gone
```

The page no longer disappears - the filmstrip shows every page of a document
whatever its state - so the assertion becomes about its status.

3. `queue-count` now reads DOCUMENT position. Any test asserting `1/4` for four
   pages of one document must assert `1/2` for two documents, and the tests that
   walked the queue with the chevrons (`next and previous walk the queue`,
   `navigation stops at both ends`, `the badge tracks position`) now walk
   documents. Rewrite them against `window.state.documents.length`.

- [ ] **Step 8: Run the whole suite**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/ -q && npx playwright test`
Expected: all green, both projects.

- [ ] **Step 9: Commit**

```bash
cd ~/projects/scanpipe
git add ui.html ui.js tests/pipeline.spec.js
git commit -m "feat: navigate documents, review pages from a filmstrip

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Mutation-test the two guarantees, then document

The auto-advance and the reopen path would both pass against a broken
implementation — a test that lands on the right page by accident, or a filmstrip
click that merely navigates. Break each and confirm the failure.

**Files:**
- Modify: `ui.js` (temporarily, then restore)
- Modify: `README.md`

- [ ] **Step 1: Break auto-advance and confirm the test catches it**

In `advanceAfterDecision`, change `if (d.pages[i].status === 'pending')` to
`if (false)`. Run:

```bash
cd ~/projects/scanpipe && npx playwright test --project=mobile -g "advances to the next"
```
Expected: FAIL at `expect(after).not.toBe(before)`. **Restore the line.**

- [ ] **Step 2: Break reopen and confirm the test catches it**

In `selectPage`, delete the `fetch('/api/reopen/...')` block so a decided page is
merely opened. Run:

```bash
cd ~/projects/scanpipe && npx playwright test --project=mobile -g "reopens it"
```
Expected: FAIL at `expect(...currentPage().status).toBe('pending')`, proving the
test checks the reopen and not just the navigation. **Restore the block.**

- [ ] **Step 3: Confirm everything is green again**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/ -q && npx playwright test`
Expected: all green.

- [ ] **Step 4: Update `README.md`**

Rewrite the "Multi-page documents" section to describe the two levels: the queue
is documents, the filmstrip is the pages of the current one, decisions are
per-page and reversible until Send, Send needs every page decided, and a sent
document leaves the queue. Update the test counts in "Tests". Add `documents.py`
to the Layout table. Note in "Known limits" that reordering pages is still not
possible and that `sent` is one-way.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add README.md
git commit -m "docs: describe the two-level document queue

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification checklist

```bash
cd ~/projects/scanpipe
./.venv/bin/python -m pytest tests/ -v
npx playwright test
./.venv/bin/python evaluate.py
git log --oneline
git status --short          # must NOT list secrets.env
```

Then review a real document on the phone at `http://192.168.1.10:8765` and
confirm: the chevrons move between documents, the filmstrip shows the right
pages, accepting walks the document, tapping a decided page reopens it, and Send
lights only when every page is decided.
