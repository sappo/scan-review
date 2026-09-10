## One more step: make the name resolve locally

The review UI is restricted to your local network. That restriction works by
source address — so a device on your LAN has to reach this server **directly**.

It won't by default. `__DOMAIN__` resolves to your *public* address, so a phone
on your own wifi leaves through the router and comes back, and most routers
rewrite the source on the way. The request then looks like it came from the
internet and is refused.

Fix it with one DNS rewrite, in whatever resolves names for your LAN:

    __DOMAIN__   ->   __LAN_IP__

In **AdGuard Home** that is *Filters → DNS rewrites → Add*. Add the **A record
only**: with no AAAA rewrite, AdGuard answers IPv6 queries with NODATA, so
clients fall back to IPv4 and arrive on the LAN address. That matters — IPv6
clients otherwise prefer this server's public address and get refused.

Then point your router's DNS at whatever holds that rewrite, and keep a public
resolver as the secondary so name resolution survives this server being down.

If your router filters DNS rebinding (AVM FRITZ!Box does), add `__DOMAIN__` to
its exception list. Without that it discards the answer for pointing a public
name at a private address, and the symptom looks like DNS working fine.

### The scanner

The Raspberry Pi authenticates to `__DOMAIN__/api/ingest` with a token, not a
password. Read it with:

    sudo yunohost app setting __APP__ ingest_token

and put it in the Pi's `~/scanpipe.env` as `SCANPIPE_INGEST_TOKEN`, with
`SCANPIPE_URL=https://__DOMAIN__`.
