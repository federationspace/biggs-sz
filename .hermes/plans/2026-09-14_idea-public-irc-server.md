# Idea: public IRC server on cluster0 (parked)

**Status:** parked 2026-09-14. UnrealIRCd was removed from the cluster in the
same change that added this note. Nothing is deployed; this is the research so
a future attempt does not restart from zero.

**Goal if resumed:** run an IRC daemon in `gregbob` and let standard clients
reach `ircs://irc.gregbob.net:6697`.

---

## Why it was parked

The daemon itself worked. The blocker was always *public transport*: IRC needs
a raw TCP port, and the only free path in front of this cluster is Cloudflare's
HTTP proxy, which carries 80/443 and nothing else. Every workaround costs money,
exposes the WAN IP, or drops client compatibility. None of those were worth it
for a server with no users yet, so the app was deleted rather than left running
half-reachable.

## What was verified (not assumed)

- UnrealIRCd 6 ran healthy in `gregbob`: real IRC handshake on both
  `192.168.2.6:6697` (TLS) and `:6667` (plaintext) from inside the LAN.
- `ircd/unrealircd:latest` ships a broken `CMD` (the whole command is one
  string, so runc tries to `stat "unrealircd -F"` and exits 128). Override with
  `command: ["/app/unrealircd/bin/unrealircd"]` + `args: ["-F"]`.
- The config must `include` the stock `modules.default.conf` and the help /
  badwords / operclass files, or the daemon refuses to start.
- The image **does** ship `websocket.so` and `websocket_common.so`, so the
  WebSocket option below is real and not hypothetical.
- Cloudflare's edge does not carry raw TCP on the free plan: live probe of
  `irc.gregbob.net` gave 6697 timeout, 6667 timeout, 443 TLS OK in 0.08s.
- TCP-over-Cloudflare is Spectrum, which needs Pro. Pro is now **$25/mo**, and
  Spectrum is the only line item on it that this cluster would use; the WAF /
  bot / cache / analytics extras are aimed at sites with real traffic.

## Options, if this is ever resumed

Ranked for the **current** topology (no Cloudflare Tunnel; the UDM
port-forwards 80/443 straight to the gateway VIP `192.168.2.9`, with Cloudflare
proxying in front, origin = the WAN IP).

1. **WireGuard only (zero public exposure).** The UDM already runs the VPN that
   replaced NetBird, and it already reaches `192.168.2.6:6697`. Every classic
   client works unchanged, nothing is published. Best fit if the server is for
   a handful of known people.
2. **Grey-cloud A record + one more router forward.** Add
   `A irc.gregbob.net -> <WAN IP>` **unproxied**, so it overrides the proxied
   `*.gregbob.net` wildcard, and forward 6697 to the IRC VIP. Standard clients,
   standard port. Cost: the WAN IP is published, with no Cloudflare shield in
   front of that port.
3. **WebSocket on 443 through the existing gateway.** Load `websocket.so`, add
   a `type websocket` listener (e.g. 4444), expose it on the Service, and point
   one HTTPRoute at it from `wildcard-gregbob-net`. Free, no router change, and
   TLS terminates at the edge with the real Let's Encrypt cert. Cost: only
   WebSocket-capable clients (web clients, KVIrc); irssi / WeeChat / mIRC
   cannot connect.
4. **Cloudflare Pro + Spectrum, $25/mo.** Buys "it just works on 6697" with the
   WAN IP still hidden. Rejected on price for a homelab.
5. **Self-hosted TCP tunnel** (frp / chisel / bore on a free-tier VPS). Fully
   open source, arbitrary ports, own domain. Most moving parts; the honest
   answer if the free Cloudflare tier is ever outgrown.
6. **Tor onion service.** Free and hides the IP, but every client needs Tor.

## Gotchas to carry forward

- An `HTTPRoute` cannot expose IRC. The first attempt routed `irc.gregbob.net`
  over HTTP to plaintext 6667, which no IRC client and no browser can use. IRC
  needs L4, so the Service must be `LoadBalancer` (or a NodePort behind a
  router forward).
- LoadBalancer VIPs come from **Cilium** LB-IPAM + BGP, not MetalLB. Pin with
  the `io.cilium/lb-ipam-ips` annotation; `spec.loadBalancerIP` and any
  `metallb.universe.tf` annotation are wrong here.
- `irc-tls` was a hand-made self-signed secret (`CN=irc.gregbob.net`), so strict
  clients flagged the certificate authority. Don't repeat that: cert-manager
  already issues `wildcard-gregbob-net` covering `*.gregbob.net` via
  Let's Encrypt DNS-01, so mount that instead.
- Split-horizon DNS hides breakage. From the LAN, `gregbob.net` resolves to the
  gateway VIP and looks fine; test the public path with
  `curl --resolve <host>:443:<cloudflare-ip>` to see what the internet sees.
- VIP `192.168.2.6` is released by this removal. It is referenced in `README.md`
  and `AGENTS.md`; both were updated to list it as free.
