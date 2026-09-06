"""Where the app keeps its data, versus where its code lives.

YunoHost replaces install_dir wholesale on upgrade and backs up only data_dir.
Every path used to derive from the source directory, so packaging the app as-is
would destroy the queue, the ground-truth corpus and every delivered PDF on the
first `yunohost app upgrade`. The two roots have to be separable.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY_BIN = str(ROOT / ".venv" / "bin" / "python")

PROBE = """
import json, os
import app
print(json.dumps({
    "spool": str(app.SPOOL), "work": str(app.WORK), "archive": str(app.ARCHIVE),
    "out": str(app.OUT), "consume": str(app.CONSUME), "truth": str(app.TRUTH),
    "log": str(app.DELIVERY_LOG), "state": str(app.STATE), "thumbs": str(app.THUMBS),
    "root": str(app.ROOT),
}))
"""


def _paths(data_dir=None):
    env = dict(os.environ, SCANPIPE_ALLOW_ANONYMOUS="1")
    if data_dir is not None:
        env["SCANPIPE_DATA"] = str(data_dir)
    else:
        env.pop("SCANPIPE_DATA", None)
    out = subprocess.run([PY_BIN, "-c", PROBE], cwd=ROOT, env=env,
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.splitlines()[-1])


import os  # noqa: E402  (after PROBE, kept next to its only user)


def test_data_defaults_to_the_source_tree(tmp_path):
    """Unset, everything stays where it has always been - dev and CI unchanged."""
    p = _paths(None)
    assert p["spool"] == str(ROOT / "spool")
    assert p["state"] == str(ROOT / "work" / "state.json")


def test_data_root_relocates_every_data_path(tmp_path):
    p = _paths(tmp_path)
    assert p["spool"] == str(tmp_path / "spool")
    assert p["work"] == str(tmp_path / "work")
    assert p["archive"] == str(tmp_path / "spool-archive")
    assert p["out"] == str(tmp_path / "out")
    assert p["consume"] == str(tmp_path / "mock-paperless" / "consume")
    assert p["truth"] == str(tmp_path / "groundtruth")
    assert p["log"] == str(tmp_path / "mock-paperless" / "deliveries.json")
    assert p["state"] == str(tmp_path / "work" / "state.json")
    assert p["thumbs"] == str(tmp_path / "work" / "thumbs")


def test_the_code_root_does_not_move_with_the_data(tmp_path):
    """ui.html, ui.js and icons.svg are code: they ship in install_dir and are
    replaced on upgrade, so they must NOT follow SCANPIPE_DATA."""
    p = _paths(tmp_path)
    assert p["root"] == str(ROOT)


def test_a_relocated_data_root_is_created_if_absent(tmp_path):
    fresh = tmp_path / "not-yet-there"
    _paths(fresh)
    for sub in ("spool", "work", "out", "groundtruth"):
        assert (fresh / sub).is_dir(), f"{sub} not provisioned"
