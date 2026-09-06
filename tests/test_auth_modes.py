"""Who is allowed in, once SSO is in front of the app.

Two clients with nothing in common:

  the operator  - a real YunoHost user, authenticated by SSOwat before the
                  request ever reaches us. SSOwat injects Ynh-User and blocks
                  clients from spoofing it, so the app can trust that header.
  the scanner   - a Raspberry Pi, not a YunoHost user, incapable of completing
                  an SSO login. Its one path is exempt from SSO, so the app
                  must authenticate it itself.

Driven through the ASGI app directly rather than over HTTP: there is no httpx
in the venv, so no TestClient.
"""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PY_BIN = str(ROOT / ".venv" / "bin" / "python")

# Exercise the middleware stack via a raw ASGI call in a subprocess, so each
# case gets a clean import with its own environment.
PROBE = r"""
import asyncio, json, os, sys
import app as A

async def call(method, path, headers):
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
             "method": method, "path": path, "raw_path": path.encode(),
             "query_string": b"", "root_path": "", "scheme": "http",
             "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
             "client": ("127.0.0.1", 1234), "server": ("127.0.0.1", 8766)}
    out = {}
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    async def send(msg):
        if msg["type"] == "http.response.start":
            out["status"] = msg["status"]
    await A.app(scope, receive, send)
    return out.get("status")

req = json.loads(sys.argv[1])
print(json.dumps({"status": asyncio.run(call(req["method"], req["path"], req["headers"]))}))
"""


def probe(method, path, headers, env_extra):
    env = dict(os.environ, **env_extra)
    env.pop("SCANPIPE_ALLOW_ANONYMOUS", None)
    out = subprocess.run(
        [PY_BIN, "-c", PROBE, json.dumps({"method": method, "path": path,
                                          "headers": headers})],
        cwd=ROOT, env=env, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout.splitlines()[-1])["status"]


TOKEN = "s3cret-scanner-token"
ENV = {"SCANPIPE_INGEST_TOKEN": TOKEN}


# --- the scanner ----------------------------------------------------------
def test_ingest_accepts_the_configured_bearer_token():
    st = probe("POST", "/api/ingest", {"authorization": f"Bearer {TOKEN}",
                                       "content-length": "0"}, ENV)
    assert st != 401, "the Pi's own token was rejected"


def test_ingest_refuses_a_wrong_token():
    assert probe("POST", "/api/ingest",
                 {"authorization": "Bearer wrong", "content-length": "0"},
                 ENV) == 401


def test_ingest_refuses_no_token_at_all():
    """SSOwat lets `visitors` through on this path, so the app is the only
    thing standing between the internet and an upload endpoint."""
    assert probe("POST", "/api/ingest", {"content-length": "0"}, ENV) == 401


def test_ingest_ignores_ynh_user_entirely():
    """A client CAN set Ynh-User on the exempt path - SSOwat is not in the way
    there to strip or validate it - so it must buy nothing."""
    assert probe("POST", "/api/ingest",
                 {"ynh-user": "admin", "content-length": "0"}, ENV) == 401


# --- the operator ---------------------------------------------------------
def test_the_ui_accepts_a_request_sswat_has_authenticated():
    assert probe("GET", "/api/queue", {"ynh-user": "kevin"}, ENV) == 200


def test_the_ui_refuses_a_request_with_no_ynh_user():
    """Defence in depth: if the app is ever reachable without SSOwat in front,
    it must not simply serve the documents."""
    assert probe("GET", "/api/queue", {}, ENV) == 401


def test_the_scanner_token_does_not_open_the_ui():
    """The Pi's credential is scoped to ingest. It is stored in cleartext on a
    device in a cupboard; it must not also read every scanned document."""
    assert probe("GET", "/api/queue",
                 {"authorization": f"Bearer {TOKEN}"}, ENV) == 401


# --- startup --------------------------------------------------------------
def test_it_refuses_to_start_without_an_ingest_token():
    out = subprocess.run([PY_BIN, "-c", "import app"], cwd=ROOT,
                         env={k: v for k, v in os.environ.items()
                              if k not in ("SCANPIPE_INGEST_TOKEN",
                                           "SCANPIPE_ALLOW_ANONYMOUS")},
                         capture_output=True, text=True)
    assert out.returncode != 0
    assert "SCANPIPE_INGEST_TOKEN" in out.stderr
