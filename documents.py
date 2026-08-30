"""Assemble the review queue as documents, not pages.

One ADF run is one document (see the batch work in
docs/superpowers/specs/2026-08-30-mobile-review-ui-design.md). The operator
thinks in documents, so the queue is shaped that way and the UI does not have to
reconstruct the grouping on every load.

Pure functions over `state`: no FastAPI, no filesystem, so the ordering and
label rules can be tested without a browser or a running server.
"""
import re
from datetime import datetime

# A document stays in the queue until it is closed - sent, or deleted. Rejected
# counts as still open on purpose: a reject has to stay reversible, and if a
# wholly rejected document vanished then rejecting the only page of a one-page
# document would be silently final.
CLOSED = ("sent", "discarded")

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
        if all(p.get("status") in CLOSED for p in members):
            continue
        members.sort(key=lambda p: (p.get("page_no") or 0, p["id"]))
        counts = {"total": len(members)}
        for st in ("pending", "accepted", "rejected"):
            counts[st] = sum(1 for p in members if p.get("status") == st)
        docs.append({
            "batch": batch,
            "label": label_for(batch),
            "ready": counts["pending"] == 0,
            # Every page declined: there is no PDF to make, so the only way to
            # close this document is to delete it.
            "deletable": counts["pending"] == 0 and counts["accepted"] == 0,
            "counts": counts,
            "pages": members,
            # A document arrives when its earliest page does.
            "_at": min(order.get(p["id"], 1 << 30) for p in members),
        })
    docs.sort(key=lambda d: d["_at"])
    for d in docs:
        d.pop("_at")
    return docs
