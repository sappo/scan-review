"""Test-suite environment.

app.py now refuses to import without credentials, which is the point: a blank
SCANPIPE_PASS used to start a server that served every scan to anyone. The unit
tests import it for its pure functions and never bind a socket, so they take the
explicit anonymous opt-in rather than inventing a password.
"""
import os

os.environ.setdefault("SCANPIPE_ALLOW_ANONYMOUS", "1")
