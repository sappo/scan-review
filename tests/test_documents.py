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
                         page("b-02.png", "b", 2, "sent")))
    assert docs == []


def test_a_discarded_document_leaves_the_queue():
    docs = D.build(state(page("b-01.png", "b", 1, "discarded")))
    assert docs == []


def test_a_wholly_rejected_document_stays_and_is_deletable():
    # It must NOT vanish: rejecting the only page of a one-page document would
    # then be silently irreversible, and reject is meant to be undoable.
    docs = D.build(state(page("b-01.png", "b", 1, "rejected")))
    assert [d["batch"] for d in docs] == ["b"]
    assert docs[0]["ready"] is True
    assert docs[0]["deletable"] is True


def test_a_document_with_something_to_keep_is_not_deletable():
    docs = D.build(state(page("b-01.png", "b", 1, "accepted"),
                         page("b-02.png", "b", 2, "rejected")))
    assert docs[0]["deletable"] is False


def test_a_document_with_one_open_page_stays():
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
