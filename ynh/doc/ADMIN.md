## Access

Two clients, two mechanisms, deliberately not interchangeable.

**You** are authenticated by YunoHost SSO before a request reaches the app.

**The scanner** cannot log in, so `/api/ingest` is exempt from SSO and the app
checks a bearer token itself. That token opens nothing else — it lives in
cleartext on a device in a cupboard.

## The local-network restriction

`lan_only` writes an nginx allowlist. It is enforced by source address, so it
depends on LAN clients reaching this server directly rather than via the
router's public address — see the post-install notes for the DNS rewrite that
makes that happen.

`lan_subnet` takes several ranges, space separated. Include an IPv6 range if
your clients reach the server over IPv6, or they will be refused.

## Where the documents live

Scans, the review queue and the ground-truth corpus are in the app's data
directory, not the install directory, so upgrades cannot destroy them. Removing
the app leaves them; only a purge deletes them.
