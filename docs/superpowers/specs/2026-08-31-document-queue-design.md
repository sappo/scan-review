# Documents in the queue, pages in a document — design

Date: 2026-08-31
Status: approved, ready for implementation planning

## Why

The queue is a flat list of pages. One ADF run already is one document
(`2026-08-30-mobile-review-ui-design.md` §6 and the batch work that followed),
but the review UI does not show that: the chevrons step pages, and which
document a page belongs to is invisible until it has been accepted and the Send
badge changes.

The operator thinks in documents. Navigation should step documents; the pages of
the current document should be visible as a group, each with its state; and a
page should still be accepted or rejected individually.

## What changes

- `GET /api/queue` returns **documents**, each carrying its pages, instead of a
  flat `pending` list.
- A page gains a `sent` status. `state["documents"]` is deleted.
- `POST /api/reopen/{page_id}` returns a decided page to `pending`.
- `GET /api/thumb/{page_id}` serves a small JPEG for the filmstrip.
- The UI gains a document navigator and a page filmstrip; accept and reject
  auto-advance within the document.

## Non-goals

- Reordering pages within a document. They come out in `page_no` order.
- Moving a page between documents.
- Any change to detection, deskew, the frame model, or PDF assembly beyond
  where `finalize` gets its page list from.

---

## 1. State

Page status becomes a four-value field:

    pending    awaiting a decision
    accepted   will go into the PDF
    rejected   will not
    sent       delivered; the decision can no longer be changed

`state["documents"]` — the map of batch to staged page ids — is **removed**.
Staged membership is derivable from status, and keeping it separately has
already cost one bug: `reset-queue.js` cleared a key that had been renamed, so
accepted pages accumulated across test runs with dangling ids. Two sources of
truth for one fact is the defect, not the specific mistake.

`state["ingested"]` keeps its meaning: arrival order, which is what orders the
documents.

## 2. The queue payload

```
GET /api/queue
{
  "documents": [
    {
      "batch":  "a4-20260831-101500",
      "label":  "A4 · 31 Aug 10:15",
      "ready":  false,
      "counts": { "total": 5, "pending": 3, "accepted": 1, "rejected": 1 },
      "pages":  [ <page>, ... ]
    }
  ]
}
```

- **Documents** are ordered by arrival: the position in `state["ingested"]` of
  the earliest page of that batch. Not by batch id — a manual `adf-scan foo`
  run has no timestamp in its name and would sort arbitrarily.
- **Pages** are ordered by `page_no`, tie-broken by `id`. Every page of the
  document is present whatever its status, so the filmstrip can show a rejected
  page greyed rather than making it vanish.
- Each page keeps the fields it has today, including `seeded`, `text_skew`,
  `detected`, `hint` and `status`.
- **`ready`** is `counts.pending == 0`. It is what lights Send.
- `counts` has no `sent` entry. A document with sent pages has left the queue by
  definition (§5), so the count would always be zero.
- A document stays while any page is not **closed**, where closed means `sent`
  or `discarded`. Rejected counts as still open on purpose.

  > **Amended during implementation.** This section originally said a wholly
  > rejected document leaves the queue, "there is nothing left to send". That
  > contradicts §4: reject is reversible until Send, but a one-page document
  > whose page was rejected would vanish, taking the only route back to that
  > page with it — and one-page documents are the common case. A wholly declined
  > document now stays, with `deletable` true, and Send becomes Delete (§5a).

`pending` disappears from the payload. Every existing e2e test reads it; see §8.

## 3. Labels

A batch id is a filename stem. When it matches `<size>-<YYYYmmdd>-<HHMMSS>`,
which is what `scanui.py` now produces, show `A4 · 31 Aug 10:15`. Otherwise show
the batch id unchanged — manual `adf-scan report` runs exist and inventing a
label for them would be a lie.

Formatting lives in Python (`documents.py`, §7) so it is unit-testable without a
browser.

## 4. Deciding a page

Accept and reject are unchanged in effect. What changes is what happens next:

- **Auto-advance.** After a decision on the page at index `i`, move to the first
  `pending` page found by scanning `i+1 … last`, then `0 … i-1`. If there is
  none, stay on `i` — now showing its new state — and the document is `ready`.
  The wrap matters because pages can be decided out of order by tapping the
  filmstrip, so the next undecided page may be behind you.
- **Reopen.** `POST /api/reopen/{page_id}` sets a page back to `pending`.
  - 404 if the page is unknown.
  - 409 if the page is `sent`. That is the one irreversible point in the
    pipeline: the PDF has been delivered.
- The per-page edit cache in the UI is keyed by page id and already survives
  navigation; reopening a page finds its previous frame intact.

## 5. Sending

`POST /api/finalize/{batch}` keeps its shape but changes two things:

- It collects the batch's `accepted` pages by status, sorted by `page_no`,
  rather than reading `state["documents"]`.
- It **refuses with 409 unless the document is `ready`**. Sending with pages
  still undecided would produce a second PDF for the same ADF run later, which
  contradicts "one run is one document". The UI only lights Send when ready, so
  this is a guard, not a path the operator meets.

On success the accepted pages become `sent`. Rejected pages stay rejected. The
document then has no `pending` or `accepted` pages and leaves the queue.

## 5a. Deleting a document

When every page is declined there is no PDF to make, so Send becomes **Delete**.
`POST /api/discard/{batch}`:

- 404 if the batch is unknown.
- 409 while any page is still `pending` or `accepted` — there is something to
  decide or something to keep, so Delete is not the right action.
- Otherwise every page becomes `discarded` and its scan is **moved to
  `spool-archive/`**, not erased. That directory already exists for scans kept
  out of the queue, and a mis-tap should not destroy a document.

`deletable` on a document is `ready && counts.accepted == 0`. It is what swaps
the button.

## 6. Thumbnails

`GET /api/thumb/{page_id}` returns a JPEG whose long side is 160px, cached at
`work/thumbs/{page_id}.jpg` and generated on first request.

The filmstrip cannot use `/api/image`, which serves the full ~1MB PNG; five of
those is 5MB to draw a strip of 96px squares. The thumbnail is of the **raw
scan**, not the cropped result — it is an index of what is in the document, and
rendering each page through `warp` on demand would be slow and would change as
the operator drags.

## 7. The UI

**Navigation.** The top chevrons step documents. The badge reads document
position, `2/3`. Expanding the title shows the document label and the page
position within it.

**Filmstrip.** A horizontally scrollable strip above the toolbar, one 96px
thumbnail per page in `page_no` order:

- undecided — plain
- accepted — a check badge
- rejected — dimmed with a cross badge
- current — outlined in the accent colour

Tapping any page opens it, decided ones included; that is the reopen path.

**Entering a document** shows its first `pending` page, or its first page if all
are decided.

**An empty queue** — no documents at all — shows the existing "queue empty"
state: no canvas, no filmstrip, navigation and the decision buttons disabled.

**Send** is enabled only when the document is `ready`, and keeps its staged
count badge. After sending, the document leaves the queue and the UI lands on
the next one.

**What this removes.** `currentBatch()`'s fallback chain and `state.lastBatch`
both exist only to guess which document Send should act on when the queue moves
under you. With an explicit document you are always inside one, so both go.

**New module.** `documents.py` holds the queue assembly: grouping pages by
batch, ordering, label formatting and the counts. `app.py` is already the
largest file in the project and this is a self-contained transformation with no
FastAPI dependency, so it can be unit-tested directly.

## 8. Testing

**Python (`tests/test_documents.py`), no browser or server:**

- grouping puts each page under its batch, ordered by `page_no`
- documents ordered by arrival, not by batch id — a manual-name batch that
  arrived first sorts first
- `ready` is true exactly when no page is pending
- counts across a mixed document
- a fully sent document is excluded; so is a fully rejected one
- label formatting for `a4-20260831-101500`, and passthrough for `report`

**API (Playwright `request`):**

- the payload shape, and that `pending` is gone
- reopen returns a decided page to pending and puts it back in `counts`
- reopen on a sent page is 409
- finalize is 409 unless ready
- finalize marks pages sent and the document leaves the queue
- `/api/thumb` returns a JPEG smaller than the source and is cached

**E2E (mobile and desktop):**

- the filmstrip shows one entry per page with the right state
- tapping a decided page reopens it and the state changes
- accept auto-advances to the next pending page
- deciding the last page leaves you put and lights Send
- the chevrons step documents, not pages
- the existing loupe, deskew, ratio-lock, PDF-size and layout tests keep passing
  once they read the new payload

## 9. Risks

- **Test churn.** Every e2e test that reads `pending` from `/api/queue` must
  change. That is most of the suite. It is mechanical, but it is the bulk of the
  work and a place to introduce mistakes quietly — the tests are the thing
  proving the rest still works.
- **The `sent` status is a one-way door** and the only one. If a document is
  sent wrongly the recourse is the paperless side, not this queue. That is
  deliberate: the alternative is a delete path into a delivered document.
- **Thumbnail cache invalidation.** Thumbnails are keyed on page id, and a page
  id is stable for the life of a scan, so a stale thumbnail is only possible if
  a spool file is replaced under an existing id — which ingest already refuses
  to do. `reset-queue.js` should clear `work/thumbs/` all the same.
