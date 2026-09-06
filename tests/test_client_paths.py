"""The client must not address the server absolutely.

A packaged install serves the app at $domain$path - often a sub-path like
/scanpipe/ - and nginx strips that prefix before the request reaches uvicorn.
A leading slash in the client therefore escapes the app's mount point and hits
the domain root, where it 404s. Relative URLs resolve against the document and
work at BOTH a domain root and a sub-path, so this is what keeps the deployment
location an install-time answer rather than a code change.

Guarded by a test because it is a one-character mistake that only shows up in
the packaged deployment, never in local development at the root.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Absolute references to endpoints or assets this app itself serves.
OFFENDERS = re.compile(r"""["'](/(?:api/|ui\.js|icons\.svg|$))""")


def _offending_lines(path):
    return [f"{path.name}:{i}: {ln.strip()}"
            for i, ln in enumerate(path.read_text().splitlines(), 1)
            if OFFENDERS.search(ln)]


def test_ui_js_uses_relative_urls():
    assert _offending_lines(ROOT / "ui.js") == []


def test_ui_html_uses_relative_urls():
    assert _offending_lines(ROOT / "ui.html") == []


def test_the_guard_would_catch_a_regression(tmp_path):
    """The pattern has to actually match what it is meant to prevent."""
    bad = tmp_path / "ui.js"
    bad.write_text("const r = await fetch('/api/queue');\n")
    assert _offending_lines(bad), "guard does not catch an absolute /api/ URL"
    good = tmp_path / "ui.js"
    good.write_text("const r = await fetch('api/queue');\n")
    assert _offending_lines(good) == [], "guard fires on a correct relative URL"
