"""Pull new scans from the Pi into the local spool.

Pull, not push: the Pi keeps every scan until this host has fetched and verified
it, so nothing is lost while this machine is unreachable or asleep. A manifest of
already-fetched files prevents duplicates, and each transfer is checksum-verified
against the source before being recorded.
"""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SPOOL = ROOT / "spool"
MANIFEST = ROOT / "work" / "fetched.json"
DEFAULT_HOST = "rpi@192.168.1.20"
REMOTE_DIR = "/home/rpi/scans"


def ssh(host, *cmd, timeout=30):
    return subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", f"ConnectTimeout={timeout}", host, *cmd],
        capture_output=True, text=True, timeout=timeout + 15)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--remote-dir", default=REMOTE_DIR)
    args = ap.parse_args()

    SPOOL.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    fetched = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}

    listing = ssh(args.host, f"sha256sum {args.remote_dir}/*.png 2>/dev/null || true")
    if listing.returncode != 0:
        # Unreachable is not an error: the Pi keeps the files, we retry later.
        print(f"scanner host unreachable ({args.host}); nothing fetched")
        return 0

    remote = {}
    for line in listing.stdout.splitlines():
        digest, _, path = line.partition("  ")
        if path:
            remote[Path(path.strip()).name] = digest.strip()
    if not remote:
        print("no scans on the host")
        return 0

    new = [n for n, d in remote.items() if fetched.get(n) != d]
    if not new:
        print(f"up to date ({len(remote)} scans on host, none new)")
        return 0

    ok = 0
    for name in sorted(new):
        dest = SPOOL / name
        cp = subprocess.run(
            ["scp", "-q", "-o", "BatchMode=yes",
             f"{args.host}:{args.remote_dir}/{name}", str(dest)],
            capture_output=True, text=True)
        if cp.returncode != 0:
            print(f"  FAILED {name}: {cp.stderr.strip()}", file=sys.stderr)
            continue
        local = sha256(dest)
        if local != remote[name]:
            print(f"  CHECKSUM MISMATCH {name}; discarding", file=sys.stderr)
            dest.unlink(missing_ok=True)
            continue
        fetched[name] = local
        ok += 1
        print(f"  fetched {name} ({dest.stat().st_size} bytes, sha256 verified)")

    MANIFEST.write_text(json.dumps(fetched, indent=2))
    print(f"fetched {ok} new scan(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
