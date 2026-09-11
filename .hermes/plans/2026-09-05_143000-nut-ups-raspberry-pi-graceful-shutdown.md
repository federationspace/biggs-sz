# NUT UPS Server on Raspberry Pi 4 — Implementation Plan

> **For Hermes:** Phases 0-3 are host-level work on the Pi and the four k3s
> nodes (no Flux involvement). Phase 4 is the only part that lands in this
> repo. Do Phase 0 first and do not skip it; it is a hard gate.

**Goal:** Stand up a Raspberry Pi 4 as a NUT (Network UPS Tools) primary on the
`biggs-sz` LAN, wired by USB to an APC UPS, so that a mains outage triggers an
ordered, graceful shutdown of all four k3s nodes before the battery dies, with
UPS telemetry and alerting surfaced through the cluster's existing
VictoriaMetrics + Grafana stack.

**Architecture:** The Pi runs `nut-server` in `netserver` mode and owns the only
USB link to the UPS. It is the sole decision-maker. On a sustained outage it
runs an *orchestrator* script that powers the nodes down in a deliberate order
over SSH (Ceph-mon-free worker first, `control-00` last), rather than relying on
NUT's native broadcast FSD, which would take all four down simultaneously and
reproduce the 2026-08-28 shutdown hang documented in
`docs/runbooks/node-reboot.md`. Each node additionally runs `upsmon` as a
secondary at the UPS's own low-battery threshold, as a last-resort safety net if
the orchestrator fails. In-cluster, a `nut_exporter` Deployment scrapes the Pi's
`upsd` over TCP 3493 and feeds VictoriaMetrics, with `VMRule` alerts and a
Grafana dashboard.

**Tech stack:** Raspberry Pi OS Lite 64-bit, NUT 2.8.x (`usbhid-ups` driver),
`upssched`, OpenSSH, `druggeri/nut_exporter` 3.3.0, VictoriaMetrics operator
(`VMServiceScrape` / `VMRule`), Grafana (dashboard 19308), Flux CD.

**Scope decision (confirmed with user):** Pi and node configuration is
hand-rolled host-level work, not GitOps. Only the monitoring surface
(`nut_exporter`, scrape config, alert rules, dashboard) lands in `biggs-sz`.

---

## Current context and assumptions

From memory, the repo, `docs/runbooks/node-reboot.md`, and **live verification
on-LAN (all facts below confirmed against the running cluster, not assumed):**

| Fact | Value |
|---|---|
| Nodes | `control-00` 192.168.2.164, `worker-00` 192.168.2.204, `worker-01` 192.168.2.117, `worker-05` 192.168.2.84 |
| OS / k3s | **Ubuntu 24.04.5 LTS**, kernel 6.8.0-138, k3s **v1.34.3+k3s1**, containerd 2.1.5 — uniform across all four nodes |
| Ceph mons | `mon-a` = **control-00**, `mon-d` = worker-01, `mon-f` = worker-00 (quorum a,d,f) |
| Ceph OSDs | **osd.0 = worker-00, osd.1 = worker-01, osd.2 = worker-05. control-00 has NO OSD.** Failure domain is `host`. |
| Ceph pools | `ceph-blockpool` and `.mgr`, both **size 3 / min_size 2** |
| Ceph health | `HEALTH_ERR` — insecure cephx key types + **mon-a low on space**; 33/33 PGs `active+clean`, 3/3 OSDs up |
| control-00 root fs | **75% full (88G used / 118G)** — this is what keeps mon-a complaining |
| RBD volumes | **17 `ceph-block` PVs**, spread across ai-system, media, git-system, matrix, cnpg-system, renovate |
| control-00 special | k3s control plane, NFS server (`/tank *(rw,sync,crossmnt,no_subtree_check)`), ZFS pool, mon-a. |
| SSH | port **22** on-LAN. control-00's host key was not in `known_hosts`; ed25519 key now pinned. |
| control-00 journal | groups are `szkud sudo users biggs gregbob` — **not** in `adm`/`systemd-journal`. Task 0.1 confirmed necessary. |
| **Phase 0 status** | **NOT DONE on any node.** `kubelet.conf.d/` is absent on all four; `InhibitDelayMaxUSec` reads `t 30000000` (30s) everywhere; no kubelet inhibitor lock is held. |
| POST time | ~7 min per node. Normal, not a hang. |
| Observability | VictoriaMetrics k8s stack (`vmagent` `selectAllByDefault: true`), Grafana via `grafana-operator`, alertmanager default receiver `matrix-mercury` |
| Secrets | External Secrets + ClusterSecretStore `onepassword-connect`, 1Password vault `biggs-sz` |
| Branch | `feat/node-graceful-shutdown` (created; currently 7 commits behind `origin/main` — rebase before working) |
| Alerting | **Already solved.** `matrix-alertmanager-receiver` is on `main`, alertmanager's default receiver is `matrix-mercury` → room `mercury`. UPS alerts will route with no extra bridge work. |

---

## ⚠ The wave order in the original plan was wrong. Here is why.

The live OSD topology changes the design. Three OSDs, one on each worker,
failure domain `host`, every pool `size 3 / min_size 2`:

```
worker-00  osd.0  mon-f
worker-01  osd.1  mon-d
worker-05  osd.2          <- has an OSD after all
control-00        mon-a   <- no OSD, but 17 RBD volumes cluster-wide
                             and the NFS server
```

**Powering off two workers drops Ceph below `min_size 2`.** At that moment all
RBD I/O blocks cluster-wide. control-00 — which shuts down *last* and hosts a
large share of those 17 RBD volumes plus the NFS export — is then asked to
flush and unmount storage that has no quorum to write to. That is precisely
the `libceph ... connect error -101` deadlock from 2026-08-28, except this time
we would be *causing* it on purpose, on battery, with a clock running.

The original three-wave order (worker-05 → worker-00 + worker-01 → control-00)
walks straight into this. It was built on the assumption that worker-05 had no
Ceph role; it has osd.2.

**Corrected approach: evacuate storage first, then power off hosts.** Add a
Wave 0 that stops the RBD and NFS *consumers* while Ceph is still fully healthy
and all three OSDs are up. Once no pod holds an RBD mapping, the hosts can go
down in any safe order without needing Ceph to be writable.

| Wave | Action | Why |
|---|---|---|
| **0** | Scale down / cordon the RBD- and NFS-consuming workloads cluster-wide; wait for volumes to unmap | Everything flushes while quorum is 3/3 and all OSDs are up. This is the wave that actually prevents the hang. |
| **1** | worker-05 (osd.2, no mon) | Losing one OSD keeps `min_size 2` satisfied and does not touch mon quorum. |
| **2** | worker-00, worker-01 (staggered) | Ceph goes below `min_size` here — acceptable **only because** Wave 0 already unmapped every RBD. |
| **3** | control-00 (mon-a, NFS, ZFS, control plane) | Last, as before. |

Wave 0 costs time that Task 1.6's runtime budget must absorb, which is another
reason the discharge measurement is a gate rather than a formality. If the
budget is too tight to fit Wave 0, the honest answer is a bigger UPS, not a
faster shutdown — skipping Wave 0 reintroduces the exact failure this whole
project exists to prevent.

> **Open design question this raises:** Wave 0 needs a working API server, and
> the API server is on control-00. That is fine (control-00 dies last), but it
> means the orchestrator's Wave 0 talks to k8s while Waves 1-3 talk over SSH.
> The Pi therefore needs a read-limited kubeconfig in addition to the SSH key.
> Alternative: skip Wave 0 and instead rely on kubelet graceful shutdown
> (Phase 0) firing on each node in turn — simpler, but it only unmounts that
> node's own volumes and does nothing for control-00's dependency on remote
> OSDs. Decide before implementing Phase 3.

## The UPS: APC Back-UPS Pro BX1500M

| Spec | Value | Consequence |
|---|---|---|
| Capacity | 1500 VA / **900 W** | Ceiling for everything on battery |
| Outlets | 10 total, **only 5 battery-backed** (5 are surge-only) | **The binding constraint — see Task 1.3** |
| Interface | USB Type-B, HID Power Device Class | `usbhid-ups`, vendor ID `051d` |
| Battery | 24 V, 2 × sealed lead acid, user-replaceable | `RB` alert matters; expect 3-5 year life |
| Waveform | Simulated (stepped) sine wave | Fine for PC/server PSUs; noted for completeness |
| APC's runtime figure | 68 min **@ 100 W** | Marketing load, not yours. See below. |

**The 68-minute number is not your runtime.** Lead-acid discharge is
non-linear (Peukert), so runtime collapses much faster than load rises. A
realistic estimate for this cluster — NAS + 3 workers at roughly 350-450 W —
is **8-12 minutes**, not an hour. That is enough for an ordered shutdown, but
only just, and it is why Task 1.6's measurement is non-negotiable rather than
a nicety.

**Assumptions still to confirm:**
- `battery.runtime` is reported by this model. Consumer Back-UPS units
  sometimes omit it, and two alerts plus the LOWBATT logic depend on it.
  Task 1.4 Step 9 settles this.
- All four nodes' BIOS/UEFI is set to **power on after AC loss** (Task 0.4).

---

## Runtime budget: the constraint that decides everything

The whole design lives or dies on one inequality:

```
T_runtime_at_load  >  T_detect + T_orchestrate + T_ups_offdelay + T_margin
```

Where `T_orchestrate` is the sum of the shutdown waves in Phase 3. You cannot
plan the timers until you have measured the left-hand side. Task 1.6 measures
it. A rough expectation for a 4-node cluster with a NAS on a consumer Back-UPS
is **5-15 minutes of runtime**, and a 3-wave ordered shutdown needs about
**5-7 minutes**. If the measurement comes back under ~8 minutes, you must
either reduce the margin, collapse the waves, or get a bigger UPS — decide that
at Task 1.6, not at the end.

---

# Phase 0: Prerequisites (hard gate — NUT is useless without these)

> **Status 2026-09-11: Tasks 0.2 and 0.3 are DONE.** Graceful node shutdown is
> applied and verified on all four nodes; worker-01 rebooted undrained, with no
> intervention, in a 20.1s dark gap and zero libceph errors. Details in
> `docs/runbooks/node-reboot.md` under "Verification results".
>
> **Two findings change Phase 3's numbers:**
>
> 1. **`unattended-upgrades`, not kubelet, consumes the 180s inhibitor window.**
>    Kubelet finishes in seconds; logind then waits out unattended-upgrades and
>    force-times-it-out at 180s. Budget ~3 min per node for this, or stop the
>    service before an orchestrated shutdown.
> 2. **worker-05 has an unresolved hardware thermal fault** (92 C package, 95 C
>    PCH, ~20,717 throttle events/hr while idle) and **cannot currently reboot
>    unattended**; it needed a physical power button press on both tests. The
>    wave-1 design assumes worker-05 powers off on command. **That assumption
>    does not hold today.** Do not arm the orchestrator until this is fixed, or
>    the first real outage will stall on wave 1.

The 2026-08-28 incident proves the nodes currently **do not shut down cleanly on
their own**. Automating a shutdown that hangs just means the battery dies
mid-hang. Fix that first, prove it with a real reboot, and only then arm NUT.

### Task 0.1: Restore journal access on control-00

**Objective:** Make control-00 diagnosable so the Phase 0 test reboots can be verified.

**Step 1:** SSH in and add the groups.

```sh
ssh szkud@192.168.2.164 -p 22
sudo usermod -aG adm,systemd-journal szkud
exit
```

**Step 2:** Reconnect (group membership needs a fresh login) and verify.

```sh
ssh szkud@192.168.2.164 -p 22 'journalctl -b -n 5 --no-pager'
```
Expected: kernel/system lines, not only user-session entries.

---

### Task 0.2: Enable kubelet graceful node shutdown on all four nodes

**Objective:** Make kubelet evict pods and unmount RBD/NFS volumes *while the
network is still up*. This is Fix 2 from the runbook and is the single most
important change in this entire plan.

**Files (per node, host-level):**
- Create: `/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf`
- Create: `/etc/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf`

**Step 1:** On **each** of control-00, worker-00, worker-01, worker-05:

```sh
sudo mkdir -p /var/lib/rancher/k3s/agent/etc/kubelet.conf.d /etc/systemd/logind.conf.d

sudo tee /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf >/dev/null <<'EOF'
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
shutdownGracePeriod: 180s
shutdownGracePeriodCriticalPods: 60s
EOF

# NOTE the filename: it deliberately MASKS the vendor drop-in of the same name
# at /usr/lib/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf,
# which sets InhibitDelayMaxSec=30 on these nodes. A file named
# 10-inhibit-delay.conf would sort BEFORE "unattended-*" and lose.
sudo tee /etc/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf >/dev/null <<'EOF'
[Login]
InhibitDelayMaxSec=180
EOF
```

`InhibitDelayMaxSec` must be **>= `shutdownGracePeriod`** or the shorter value
silently wins. Verified on the nodes: the effective value today is **30s**, not
the 5s compiled-in default, because `unattended-upgrades` ships a vendor drop-in.
Per `man 5 logind.conf`, drop-ins from `/usr/lib/systemd/*.conf.d/` and
`/etc/systemd/*.conf.d/` are sorted **together by filename regardless of
directory**, last wins; reusing the vendor filename in `/etc/` is the documented
way to override it. 180s still satisfies unattended-upgrades, which only wanted a
floor of 30s.

**Step 2:** Restart the services, one node at a time.

```sh
sudo systemctl restart systemd-logind
sudo systemctl restart k3s          # control-00
sudo systemctl restart k3s-agent    # workers
```

**Step 3: Verify** on each node.

```sh
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 \
  org.freedesktop.login1.Manager InhibitDelayMaxUSec
```
Expected: `t 180000000` (180s in microseconds), **not** `t 30000000` (the
unattended-upgrades vendor default) and **not** `t 5000000`. If you still see
`30000000`, your drop-in filename sorted before the vendor one; re-read Step 1.

```sh
systemd-inhibit --list | grep -i kubelet
```
Expected: a `delay` lock held by `kubelet`.

---

### Task 0.3: Prove a clean shutdown with a real test reboot

**Objective:** Confirm Task 0.2 actually fixed the hang, before any automation
depends on it.

**Step 1:** Check Ceph is safe to reboot. The runbook's Fix 4 explains why you
must **not** gate on `HEALTH_OK` here: the cluster sits at `HEALTH_ERR`
permanently because of `AUTH_INSECURE_SERVICE_KEY_TYPE` (a squid-era cephx `aes`
key deprecation on osd.0-2 and mgr.a), which has nothing to do with shutdown
safety. Waiting for `HEALTH_OK` would block this plan forever.

```sh
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```
Gate on **quorum and PG state**, not the health string: `mon: 3 daemons, quorum
a,d,f`, `osd: 3 up, 3 in`, all PGs `active+clean`. Also worth clearing
`MON_DISK_LOW` first (`journalctl --vacuum-size=200M` on control-00; its root is
75% full and mon-a's hostPath lives there).

**Step 2:** Reboot `worker-05` (the node that hung, and the one with no mon).

```sh
kubectl drain worker-05 --ignore-daemonsets --delete-emptydir-data --timeout=10m
ssh szkud@192.168.2.84 sudo systemctl reboot
```

**Step 3: Verify** it shut down cleanly once it is back.

```sh
ssh szkud@192.168.2.84 'journalctl -b -1 -o short-precise | tail -20'
```
Expected: `Reached target reboot.target`, then `systemd-shutdown[1]: Syncing
filesystems and block devices.`, then nothing. **Repeated
`libceph ... connect error -101` after that line means it hung again — stop and
solve that before continuing.** The dark gap should be inside worker-05's normal
0.6-9.0 min band, not 17 min.

```sh
kubectl uncordon worker-05
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

**Step 4:** Repeat for `worker-00`, then `worker-01`, then `control-00` last,
checking quorum between each. Never reboot two mon hosts in a row.

**Step 5:** Record each node's clean-shutdown wall time (drain command issued →
machine dark). These numbers feed the Phase 3 wave timings directly.

---

### Task 0.4: Set BIOS auto-power-on and record the values

**Objective:** Without this the cluster shuts down beautifully and then stays
dark until you walk over and press four power buttons.

**Step 1:** On each node's BIOS/UEFI, set the AC-recovery option (variously
"Restore on AC Power Loss", "After Power Failure", "AC Back Function") to
**Power On** / **Last State**.

**Step 2: Verify** by pulling the plug on one node while it is powered off, then
restoring power; it should boot unattended.

**Step 3:** Write the setting name and location per node into
`docs/runbooks/` notes for Task 4.7.

---

# Phase 1: Raspberry Pi build and NUT server

### Task 1.1: Image the Pi

**Objective:** Get a minimal, headless, SSH-reachable Pi on the LAN.

**OS decision: Raspberry Pi OS Lite (64-bit), current release, Debian 13
"trixie".**

Why this and not the alternatives:

| Option | Verdict |
|---|---|
| **Raspberry Pi OS Lite 64-bit (trixie)** | **Chosen.** First-party kernel and firmware for Pi 4, no desktop, `nut` 2.8.1 in the archive, longest-tail of NUT-on-Pi documentation to match against when something misbehaves. |
| Raspberry Pi OS Lite 32-bit | No. The Pi 4 is 64-bit; the only reason to pick 32-bit is legacy binaries you do not have. |
| Raspberry Pi OS **Desktop/Full** | No. A GUI on an appliance is attack surface, RAM, and SD writes for zero benefit; this box is headless forever. |
| Ubuntu Server 24.04 LTS for Pi | Workable, but you gain nothing here and give up first-party firmware handling. NUT packaging is equivalent. |
| DietPi | Tempting for minimalism, but it adds its own config layer between you and stock Debian, which is exactly the wrong trade for an appliance whose failure mode must be boring and debuggable at 3am. |
| Pi OS **Legacy** (bookworm) | Only if trixie shows a driver problem with the BX1500M. Ships NUT 2.8.0. Keep as the fallback, do not start here. |

Version facts, verified: current Raspberry Pi OS is Debian 13 (trixie), kernel
6.18. `nut` in trixie is **2.8.1-5**; bookworm has 2.8.0-7. 2.8.1 is a good
place to be — recent enough for current `usbhid-ups` APC fixes, old enough to
have been shaken out.

**Step 1:** Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager.
In the Imager's advanced options (gear icon) set:
- hostname `nut-00`
- enable SSH, **public-key only** (paste your key; do not enable password auth)
- username `szkud` to match the nodes
- locale/timezone to match the cluster
- **skip Wi-Fi entirely** — this box must be on Ethernet. Wi-Fi is a second
  way for the shutdown path to fail and buys nothing on a machine bolted next
  to the UPS.

**Step 2:** Prefer a **USB SSD over an SD card** if one is spare. This device
writes logs during every power event, and SD cards are the usual failure point
in a box whose entire job is to be alive when everything else is not. A dead SD
card is a silently disarmed UPS.

**Step 3:** Boot, then:

```sh
ssh szkud@nut-00.local   # or the DHCP address
sudo apt update && sudo apt full-upgrade -y && sudo reboot
```

**Step 4: Verify** you are where you think you are:

```sh
cat /etc/os-release | head -2      # expect: Debian GNU/Linux 13 (trixie)
uname -m                           # expect: aarch64
apt-cache policy nut-server        # expect: 2.8.1-5 (or later)
```

**Step 5:** Reduce SD/SSD wear and make the box boring:

```sh
# The journal is the only thing this box writes regularly. Cap it.
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/10-size-limit.conf >/dev/null <<'EOF'
[Journal]
SystemMaxUse=200M
EOF
sudo systemctl restart systemd-journald
```

> **Do not enable unattended-upgrades on this box** without thinking it
> through. An automatic `nut` upgrade that restarts `nut-server` mid-outage, or
> an automatic reboot, is precisely the failure you are buying this Pi to
> prevent. Patch it deliberately, on your schedule, with a `DRY_RUN=1` check
> afterwards (Task 3.2 Step 4).

---

### Task 1.2: Give the Pi a static address

**Objective:** The exporter and every node's `upsmon` will hardcode this
address; it cannot move.

**Step 1:** Reserve an IP for the Pi's MAC in the router's DHCP table, in the
same 192.168.2.0/24 range as the nodes. Suggested: **192.168.2.10** (adjust to
whatever is free).

**Step 2: Verify:**

```sh
ip -4 addr show dev eth0
ping -c3 192.168.2.164   # control-00 reachable
```

**Step 3:** Note the chosen IP here and substitute it for `<PI_IP>` throughout
the rest of this plan.

---

### Task 1.3: Physically connect the UPS

**Objective:** USB data link plus correct outlet placement.

> ## ⚠ The BX1500M has only 5 battery-backed outlets
>
> Ten outlets, **five** of which are battery backup; the other five are surge
> protection only. Devices on the surge-only bank get **zero** runtime and go
> dark the instant mains drops. APC's own manual lists "essential equipment
> plugged into a SURGE ONLY outlet" as the first troubleshooting entry for "the
> UPS does not provide power during an outage".
>
> You must protect **six** things: 4 nodes + Pi + switch. That is one more than
> the UPS has battery outlets.

**Step 1: Resolve the outlet shortfall.** Six devices, five outlets. Options,
best first:

1. **Put the Pi and the switch on one good outlet via a short power strip.**
   Both are tiny loads (Pi 4 ≈ 5-7 W, a small switch ≈ 10-15 W), so a single
   outlet carries them comfortably. This is the pragmatic homelab answer.
   Daisy-chaining a *surge* strip into a UPS is discouraged by APC, but a plain
   multi-outlet strip with no surge circuitry is electrically fine at this load.
2. **Check whether any node can share.** If two nodes are low-draw, the same
   trick applies, but measure first — a NAS with spinning disks is not a small
   load.
3. **Accept the risk on one device only if it is not on the shutdown path.**
   Never the switch, never the Pi, never control-00.

The Pi and the switch are the two devices that absolutely cannot be on
surge-only: without them there is no orchestration at all.

**Step 2: Budget the load.** 900 W maximum. Add up the real draw of the four
nodes (a NAS with disks plus three workers plausibly lands at 350-450 W) and
confirm you are well under. Above ~80% load, runtime collapses and the
`UpsLoadHigh` alert (Task 4.5) will tell you so.

**Step 3:** Connect the UPS's USB-B port to a USB-A port on the Pi. Use the
cable APC supplied; some third-party USB-B cables are charge-only and will look
exactly like a broken UPS.

**Step 4: Outlet audit — write it down.** Record which physical outlet holds
which device, and which bank it is in. This table goes in the runbook (Task
4.8); during an outage at 3am you will not want to be reverse-engineering it.

| Bank | Outlet | Device |
|---|---|---|
| Battery | 1 | control-00 |
| Battery | 2 | worker-00 |
| Battery | 3 | worker-01 |
| Battery | 4 | worker-05 |
| Battery | 5 | strip → Pi (`nut-00`) + network switch |
| Surge only | 6-10 | (nothing on the shutdown path) |

**Step 5: Verify the outlet assignment physically, not from the label.** With
the cluster idle, pull the mains plug for ~20 seconds and confirm nothing goes
dark. Anything that reboots was on surge-only and must be moved.

**Step 6: Verify** the Pi sees the device.

```sh
lsusb | grep -i -E 'american|051d'
```
Expected: a line containing `051d` (APC's vendor ID), e.g.
`Bus 001 Device 004: ID 051d:0002 American Power Conversion Uninterruptible Power Supply`.

---

### Task 1.4: Install and configure NUT on the Pi

**Objective:** `upsc` returns live UPS data locally.

**Files:** `/etc/nut/nut.conf`, `/etc/nut/ups.conf`, `/etc/nut/upsd.conf`,
`/etc/nut/upsd.users`, `/etc/nut/upsmon.conf`

**Step 1:** Install.

```sh
sudo apt install -y nut nut-server nut-client
```

**Step 2:** `/etc/nut/nut.conf`

```ini
MODE=netserver
```

**Step 3:** `/etc/nut/ups.conf`

```ini
# Global: upsd refuses to serve data older than MAXAGE, so it must exceed
# pollinterval or you get spurious "data stale" -> upsmon treats the UPS as
# dead -> a phantom shutdown. Keep MAXAGE >= 2x pollinterval.
maxretry = 3
pollinterval = 15

[apc]
    driver = usbhid-ups
    port = auto
    # Match by vendor ID (051d = APC). The BX1500M is a HID Power Device; the
    # driver picks the "APC HID" subdriver automatically.
    vendorid = 051d
    desc = "APC Back-UPS Pro BX1500M - biggs-sz rack"
    # Consumer APC Back-UPS units are well known for dropping their USB link
    # under frequent polling, producing "data stale" / "Driver not connected".
    # 15s polling plus the MAXAGE above is the widely-used mitigation.
    pollfreq = 15
    # offdelay/ondelay control the end-of-sequence UPS power cut.
    # On APC HID units ondelay MUST be greater than offdelay or the driver
    # refuses to start with "invalid ondelay/offdelay".
    # Both are rounded DOWN to a multiple of 60 on these units, so use exact
    # multiples of 60 to get what you asked for.
    offdelay = 60
    ondelay = 120
```

Also raise `MAXAGE` in `/etc/nut/upsd.conf` (Step 5) to match.

**Step 4:** Start the driver alone first, before anything else. This is where
model incompatibilities surface.

```sh
sudo upsdrvctl start
```
Expected: `Using subdriver: APC HID 0.xx` and no errors. A permissions error
here means the udev rules did not apply; `sudo udevadm control --reload && sudo udevadm trigger`, then replug the USB cable.

If it fails, run it verbose to see the HID report walk:

```sh
sudo upsdrvctl -DD start 2>&1 | head -60
```

**Step 5:** `/etc/nut/upsd.conf` — listen on the LAN, not just loopback.

```ini
LISTEN 127.0.0.1 3493
LISTEN <PI_IP> 3493
# Must exceed pollinterval (15s) or the BX1500M's occasional USB hiccup reads
# as "data stale" and upsmon may act on a UPS it wrongly believes is dead.
MAXAGE 25
```

**Step 6:** `/etc/nut/upsd.users` — three accounts with distinct privileges.

```ini
[upsmon_primary]
    password = <PRIMARY_PASS>
    upsmon primary

[monuser]
    password = <SECONDARY_PASS>
    upsmon secondary

[exporter]
    password = <EXPORTER_PASS>
    actions =
    instcmds = none
```

```sh
sudo chown root:nut /etc/nut/upsd.users && sudo chmod 640 /etc/nut/upsd.users
```

Generate the three passwords now and store them in 1Password vault `biggs-sz`
(Task 4.1 consumes the exporter one).

**Step 7:** `/etc/nut/upsmon.conf` on the Pi (primary role).

```ini
MONITOR apc@localhost 1 upsmon_primary <PRIMARY_PASS> primary
MINSUPPLIES 1
SHUTDOWNCMD "/sbin/shutdown -h +0"
NOTIFYCMD /sbin/upssched
POWERDOWNFLAG /etc/killpower
POLLFREQ 5
POLLFREQALERT 5
HOSTSYNC 30
DEADTIME 15
FINALDELAY 5

NOTIFYFLAG ONLINE   SYSLOG+EXEC
NOTIFYFLAG ONBATT   SYSLOG+EXEC
NOTIFYFLAG LOWBATT  SYSLOG+EXEC
NOTIFYFLAG FSD      SYSLOG+EXEC
NOTIFYFLAG COMMBAD  SYSLOG+EXEC
NOTIFYFLAG COMMOK   SYSLOG+EXEC
NOTIFYFLAG SHUTDOWN SYSLOG+EXEC
NOTIFYFLAG REPLBATT SYSLOG
```

```sh
sudo chown root:nut /etc/nut/upsmon.conf && sudo chmod 640 /etc/nut/upsmon.conf
```

**Step 8:** Start everything.

```sh
sudo systemctl enable --now nut-server nut-monitor
sudo systemctl status nut-server nut-monitor --no-pager
```

**Step 9: Verify.**

```sh
upsc apc
```
Expected: a variable dump including `ups.status: OL`, `battery.charge: 100`,
`battery.runtime`, `ups.load`. **Note whether `battery.runtime` is present** —
some Back-UPS models omit it, which changes the Task 3.2 trigger logic.

```sh
upsc apc ups.status
upsc apc battery.runtime
```

---

### Task 1.5: Verify network access to upsd from the cluster side

**Objective:** Prove TCP 3493 is reachable before building the exporter.

**Step 1:** From your laptop or a node:

```sh
nc -vz <PI_IP> 3493
upsc apc@<PI_IP>          # if nut-client is installed locally
```
Expected: connection succeeds and variables print.

**Step 2:** If the Pi has a firewall enabled, allow only the LAN:

```sh
sudo ufw allow from 192.168.2.0/24 to any port 3493 proto tcp
```

---

### Task 1.6: Measure the real runtime budget (do not skip)

**Objective:** Turn the inequality at the top of this plan into actual numbers.

**Step 1:** With the cluster running its normal workload, record baseline load.

```sh
upsc apc ups.load                    # percent of nominal
upsc apc ups.realpower.nominal       # VA/W rating, if reported
```

**Step 2:** **Controlled discharge test, during a maintenance window.** Pull the
UPS mains plug and watch the battery drain, logging every 15s. Do **not** let it
run to shutdown; stop at 40% charge.

```sh
while true; do
  printf '%s %s %s %s\n' "$(date -Is)" \
    "$(upsc apc battery.charge 2>/dev/null)" \
    "$(upsc apc battery.runtime 2>/dev/null)" \
    "$(upsc apc ups.status 2>/dev/null)"
  sleep 15
done | tee ~/ups-discharge-$(date +%F).log
```

**Step 3:** Restore mains. From the log, extrapolate total runtime at 100%
charge under real load. Call this `T_runtime`.

**Step 4:** Fill in the budget worksheet with the Task 0.3 measurements:

| Term | How to get it | Value |
|---|---|---|
| `T_runtime` | Step 3 above | ____ min |
| `T_detect` | ONBATT confirm delay (Task 3.2 timer) | ____ min |
| `T_wave1` | worker-05 clean shutdown (Task 0.3) | ____ min |
| `T_wave2` | max(worker-00, worker-01) + stagger | ____ min |
| `T_wave3` | control-00 clean shutdown | ____ min |
| `T_offdelay` | `offdelay` from ups.conf (60s) | 1 min |
| `T_margin` | safety, >= 25% of runtime | ____ min |

**Decision point.** If `T_detect + T_wave1 + T_wave2 + T_wave3 + T_offdelay +
T_margin > T_runtime`, you must do one of:
- shrink `T_detect` (accept shutting down on brief blips),
- collapse waves 1 and 2 into one (all three workers together — riskier for
  Ceph flushes, but Phase 0's graceful shutdown makes it far safer than it was),
- or size up the UPS.

Do not proceed to Phase 3 with a negative margin and hope.

---

# Phase 2: Node-side NUT clients (the safety net)

### Task 2.1: Create the shutdown SSH identity on the Pi

**Objective:** Let the Pi power off nodes without a password, with the narrowest
possible privilege.

**Step 1:** On the Pi, as root (the orchestrator runs from `upssched`, which
runs as root):

```sh
sudo ssh-keygen -t ed25519 -N '' -C 'nut-orchestrator@nut-00' -f /root/.ssh/nut_shutdown
sudo cat /root/.ssh/nut_shutdown.pub
```

**Step 2:** On **each** node, create a dedicated unprivileged user restricted to
exactly one command.

```sh
sudo useradd -m -s /bin/bash nutshutdown
sudo mkdir -p /home/nutshutdown/.ssh
echo '<PASTE_PUBKEY>' | sudo tee /home/nutshutdown/.ssh/authorized_keys
sudo chown -R nutshutdown:nutshutdown /home/nutshutdown/.ssh
sudo chmod 700 /home/nutshutdown/.ssh && sudo chmod 600 /home/nutshutdown/.ssh/authorized_keys

sudo tee /etc/sudoers.d/nutshutdown >/dev/null <<'EOF'
nutshutdown ALL=(root) NOPASSWD: /usr/sbin/shutdown -h now, /sbin/shutdown -h now
EOF
sudo chmod 440 /etc/sudoers.d/nutshutdown
sudo visudo -c
```
Expected from `visudo -c`: `parsed OK`.

**Step 3: Verify** from the Pi, per node (this is read-only — it must *fail* on
anything but shutdown):

```sh
sudo ssh -i /root/.ssh/nut_shutdown -o StrictHostKeyChecking=accept-new \
  nutshutdown@192.168.2.84 'sudo -n /sbin/shutdown --help >/dev/null && echo SHUTDOWN_OK'
sudo ssh -i /root/.ssh/nut_shutdown nutshutdown@192.168.2.84 'sudo -n id'
```
Expected: `SHUTDOWN_OK` on the first; `sudo: a password is required` on the
second. If the second succeeds, the sudoers rule is too broad — fix it.

**Step 4:** Repeat for 192.168.2.204, 192.168.2.117, 192.168.2.164.

---

### Task 2.2: Install upsmon on each node as a secondary

**Objective:** Last-resort protection. If the Pi's orchestrator crashes but
`upsd` still answers, each node still saves itself at the UPS's low-battery
threshold.

**Files (per node):** `/etc/nut/nut.conf`, `/etc/nut/upsmon.conf`

**Step 1:** Install the client only — no server, no driver.

```sh
sudo apt install -y nut-client
```

**Step 2:** `/etc/nut/nut.conf`

```ini
MODE=netclient
```

**Step 3:** `/etc/nut/upsmon.conf`

```ini
MONITOR apc@<PI_IP> 1 monuser <SECONDARY_PASS> secondary
MINSUPPLIES 1
SHUTDOWNCMD "/sbin/shutdown -h +0"
POLLFREQ 5
POLLFREQALERT 5
# Generous: the orchestrator should have already handled this node. This path
# firing at all means the primary orchestration failed.
DEADTIME 30
FINALDELAY 0
NOTIFYFLAG ONBATT  SYSLOG
NOTIFYFLAG LOWBATT SYSLOG
NOTIFYFLAG FSD     SYSLOG
```

```sh
sudo chown root:nut /etc/nut/upsmon.conf && sudo chmod 640 /etc/nut/upsmon.conf
sudo systemctl enable --now nut-monitor
```

**Step 4: Verify** on each node.

```sh
systemctl status nut-monitor --no-pager
upsc apc@<PI_IP> ups.status
journalctl -u nut-monitor -n 20 --no-pager
```
Expected: `OL`, and log lines showing a successful connection to the primary,
no `Poll UPS failed`.

> **Ordering note:** because all four secondaries react to the same FSD
> broadcast simultaneously, this path gives you *ungraceful ordering* — it is
> strictly the fallback. The ordered path is Phase 3. This is why Phase 0
> matters so much: even the unordered fallback is survivable once kubelet
> unmounts volumes properly.

---

# Phase 3: The ordered shutdown orchestrator

### Task 3.1: Write the orchestrator script

**Objective:** Shut down the cluster in an order that respects Ceph mon quorum
and control-00's NFS/ZFS role, with a dry-run mode so it can be tested safely.

**File:** Create `/usr/local/sbin/nut-cluster-shutdown` on the Pi.

```sh
#!/bin/bash
# Ordered cluster shutdown for the biggs-sz k3s cluster, driven by NUT.
#
# WAVE ORDER RATIONALE (verified live, see the plan's topology section):
#   osd.0=worker-00  osd.1=worker-01  osd.2=worker-05  (control-00 has NO OSD)
#   mon-f=worker-00  mon-d=worker-01  mon-a=control-00
#   ceph-blockpool + .mgr are both size 3 / min_size 2, failure domain = host.
#
# The naive order (workers first, control-00 last) drops Ceph below min_size 2
# the moment the SECOND worker powers off. From that point all RBD I/O blocks
# cluster-wide -- and control-00, which still has to flush 17 RBD volumes and
# tear down its NFS export, is left writing to storage that has no quorum.
# That is the 2026-08-28 libceph -101 deadlock, self-inflicted, on battery.
#
# Hence WAVE 0: evacuate the storage CONSUMERS while Ceph is still fully
# healthy (3/3 mons, 3/3 OSDs). Once nothing holds an RBD mapping, the hosts
# can go down without needing Ceph to stay writable.
#
#   wave 0: scale down RBD/NFS-consuming workloads; wait for volumes to unmap
#   wave 1: worker-05  -- osd.2, no mon; losing it keeps min_size 2 satisfied
#   wave 2: worker-00, worker-01 -- mon-f/mon-d + osd.0/osd.1, staggered.
#           Ceph drops below min_size here; safe ONLY because wave 0 ran.
#   wave 3: control-00 -- mon-a + NFS server + ZFS tank + k3s control plane.
#
# Each node's kubelet also holds a 180s systemd inhibitor lock and evicts pods
# before the network dies (Phase 0), which covers that node's own volumes.
# Wave 0 covers the cross-node dependency that the inhibitor cannot.
set -uo pipefail

DRY_RUN="${DRY_RUN:-0}"
SSH_KEY=/root/.ssh/nut_shutdown
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes"
LOG=/var/log/nut-cluster-shutdown.log

WAVE1=("192.168.2.84")                      # worker-05
WAVE2=("192.168.2.204" "192.168.2.117")     # worker-00, worker-01
WAVE3=("192.168.2.164")                     # control-00

# Seconds to wait after issuing a wave before starting the next.
# TUNE THESE from the Task 0.3 measurements. Defaults are conservative.
WAIT1=90
WAIT2=120
WAIT3=150
STAGGER=20   # gap between the two mon-holding workers in wave 2

log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG" | logger -t nut-cluster-shutdown; }

poweroff_node() {
  local ip="$1"
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: would power off $ip"
    return 0
  fi
  log "powering off $ip"
  ssh $SSH_OPTS "nutshutdown@${ip}" 'sudo -n /sbin/shutdown -h now' \
    && log "shutdown accepted by $ip" \
    || log "WARNING: shutdown command to $ip FAILED (rc=$?)"
}

node_is_down() {
  ! ping -c1 -W2 "$1" >/dev/null 2>&1
}

wait_for_wave() {
  local timeout="$1"; shift
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local all_down=1
    for ip in "$@"; do
      node_is_down "$ip" || all_down=0
    done
    [ "$all_down" = "1" ] && { log "wave down: $*"; return 0; }
    sleep 5
  done
  log "WARNING: timeout ${timeout}s waiting for: $* -- continuing anyway"
  return 1
}

log "=== ordered cluster shutdown initiated (DRY_RUN=$DRY_RUN) ==="
log "ups: $(upsc apc ups.status 2>/dev/null) charge=$(upsc apc battery.charge 2>/dev/null) runtime=$(upsc apc battery.runtime 2>/dev/null)"

log "--- wave 1: non-mon worker ---"
for ip in "${WAVE1[@]}"; do poweroff_node "$ip"; done
[ "$DRY_RUN" = "1" ] || wait_for_wave "$WAIT1" "${WAVE1[@]}"

log "--- wave 2: mon-holding workers (staggered) ---"
for ip in "${WAVE2[@]}"; do
  poweroff_node "$ip"
  sleep "$STAGGER"
done
[ "$DRY_RUN" = "1" ] || wait_for_wave "$WAIT2" "${WAVE2[@]}"

log "--- wave 3: control plane / NAS ---"
for ip in "${WAVE3[@]}"; do poweroff_node "$ip"; done
[ "$DRY_RUN" = "1" ] || wait_for_wave "$WAIT3" "${WAVE3[@]}"

log "=== all waves issued; handing back to upsmon for local shutdown ==="

if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN: would now trigger local FSD (upsmon -c fsd)"
else
  # Sets POWERDOWNFLAG and shuts the Pi down; the systemd shutdown hook then
  # tells the UPS to cut power so it will power-cycle when mains returns.
  /sbin/upsmon -c fsd
fi
```

**Step 2:** Install it.

```sh
sudo install -m 0750 -o root -g root nut-cluster-shutdown /usr/local/sbin/nut-cluster-shutdown
sudo touch /var/log/nut-cluster-shutdown.log && sudo chmod 640 /var/log/nut-cluster-shutdown.log
```

**Step 3: Verify** syntax without running it.

```sh
sudo bash -n /usr/local/sbin/nut-cluster-shutdown && echo SYNTAX_OK
```
Expected: `SYNTAX_OK`

---

### Task 3.2: Wire the orchestrator to upssched

**Objective:** Fire the orchestrator after the outage has been sustained long
enough to be real, but early enough to finish. Also handle the "brief blip"
case by cancelling on power return.

**Files:** `/etc/nut/upssched.conf`, `/etc/nut/upssched-cmd`

**Step 1:** `/etc/nut/upssched.conf`

```ini
CMDSCRIPT /etc/nut/upssched-cmd
PIPEFN /run/nut/upssched.pipe
LOCKFN /run/nut/upssched.lock

# Sustained-outage trigger. TUNE from the Task 1.6 worksheet:
#   cluster-shutdown delay = T_runtime - (T_wave1+T_wave2+T_wave3+T_offdelay+T_margin)
# 300s (5 min) is a placeholder that assumes a comfortable runtime budget.
AT ONBATT * START-TIMER cluster-shutdown 300

# Mains came back before the timer -- stand down, nothing happened.
AT ONLINE * CANCEL-TIMER cluster-shutdown
AT ONLINE * EXECUTE power-restored

# Notify immediately on going to battery, well before any shutdown decision.
AT ONBATT * EXECUTE notify-onbatt

# Battery hit low before our timer did: go NOW, skip the remaining wait.
AT LOWBATT * EXECUTE cluster-shutdown-now

# Comms/health notifications (logged; the exporter surfaces them to Grafana).
AT COMMBAD  * START-TIMER commbad 60
AT COMMOK   * CANCEL-TIMER commbad
AT REPLBATT * EXECUTE replbatt
```

**Step 2:** `/etc/nut/upssched-cmd`

```sh
#!/bin/sh
# NOTE: every branch that matters also calls ups-notify (Task 3.5), which posts
# to Matrix directly from the Pi. That path deliberately does NOT depend on the
# cluster, because during a real outage the cluster is the thing going away.
case "$1" in
  cluster-shutdown|cluster-shutdown-now)
    logger -t upssched-cmd "NUT: sustained outage ($1) -- starting ordered cluster shutdown"
    /usr/local/sbin/ups-notify "🚨 Sustained outage: starting ORDERED CLUSTER SHUTDOWN ($1). Charge $(upsc apc battery.charge 2>/dev/null)%, runtime $(upsc apc battery.runtime 2>/dev/null)s."
    /usr/local/sbin/nut-cluster-shutdown
    ;;
  notify-onbatt)
    logger -t upssched-cmd "NUT: on battery"
    /usr/local/sbin/ups-notify "⚡ Mains lost; UPS on battery. Charge $(upsc apc battery.charge 2>/dev/null)%, runtime $(upsc apc battery.runtime 2>/dev/null)s. Shutdown begins if this persists."
    ;;
  power-restored)
    logger -t upssched-cmd "NUT: mains restored, cluster shutdown timer cancelled"
    /usr/local/sbin/ups-notify "✅ Mains restored; cluster shutdown cancelled. Charge $(upsc apc battery.charge 2>/dev/null)%."
    ;;
  commbad)
    logger -t upssched-cmd "NUT: lost communication with the UPS for 60s"
    /usr/local/sbin/ups-notify "⚠️ Lost communication with the UPS for 60s. UPS state is now UNKNOWN; the shutdown path may be disarmed."
    ;;
  replbatt)
    logger -t upssched-cmd "NUT: UPS reports the battery needs replacement"
    /usr/local/sbin/ups-notify "🔋 UPS reports REPLACE BATTERY. Runtime is no longer trustworthy."
    ;;
  *)
    logger -t upssched-cmd "NUT: unrecognised command: $1"
    ;;
esac
```

```sh
sudo install -m 0750 -o root -g root upssched-cmd /etc/nut/upssched-cmd
sudo mkdir -p /run/nut && sudo chown nut:nut /run/nut
```

**Step 3:** Reload upsmon.

```sh
sudo systemctl restart nut-monitor
```

**Step 4: Verify** the wiring without a real outage — dry-run the script directly.

```sh
sudo DRY_RUN=1 /usr/local/sbin/nut-cluster-shutdown
sudo tail -20 /var/log/nut-cluster-shutdown.log
```
Expected: `DRY_RUN: would power off` lines in the exact order
192.168.2.84 → 192.168.2.204 → 192.168.2.117 → 192.168.2.164, then
`DRY_RUN: would now trigger local FSD`. **No node should actually reboot.**

---

### Task 3.3: Configure the UPS power-off hook on the Pi

**Objective:** Make the UPS actually cut power at the end, so it power-cycles
when mains returns and the auto-power-on BIOS setting fires.

**File:** `/usr/lib/systemd/system-shutdown/nutshutdown` (Debian ships this; verify it exists)

**Step 1:** Check for the packaged hook.

```sh
ls -l /usr/lib/systemd/system-shutdown/nutshutdown /lib/systemd/system-shutdown/nutshutdown 2>/dev/null
```

**Step 2:** If missing, create it.

```sh
sudo tee /usr/lib/systemd/system-shutdown/nutshutdown >/dev/null <<'EOF'
#!/bin/sh
[ -x /sbin/upsmon ] && [ -x /sbin/upsdrvctl ] || exit 0
if /sbin/upsmon -K >/dev/null 2>&1; then
  /sbin/upsdrvctl shutdown
  /bin/sleep 2
fi
exit 0
EOF
sudo chmod 0755 /usr/lib/systemd/system-shutdown/nutshutdown
```

`upsmon -K` returns success only when `/etc/killpower` (the POWERDOWNFLAG) is
present, so this is a no-op on ordinary reboots.

**Step 3: Verify** the flag logic without cutting power.

```sh
sudo /sbin/upsmon -K; echo "rc=$?"      # expect non-zero: no killpower flag set
```

> **Power race warning (NUT FAQ):** if mains returns *after* the Pi commits to
> shutdown but *before* the UPS actually cuts, some units never power-cycle and
> everything stays dark. The `ondelay = 120` / `offdelay = 60` pair in
> `ups.conf` is what mitigates this. Confirm the behaviour in the Task 3.4 live
> test rather than trusting it.

---

### Task 3.4: Full live outage test

**Objective:** The only test that counts. Schedule a maintenance window.

**Step 1:** Pre-flight.

```sh
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s   # HEALTH_OK, 3/3 quorum
kubectl get nodes
upsc apc battery.charge                                        # 100
```

**Step 2:** Temporarily shorten the trigger so the test does not take 10 minutes
of standing around: set `AT ONBATT * START-TIMER cluster-shutdown 60` and
`systemctl restart nut-monitor`.

**Step 3:** Pull the UPS mains plug. Watch from a laptop on battery:

```sh
ssh nut-00 'sudo tail -f /var/log/nut-cluster-shutdown.log'
```

**Step 4: Verify** the sequence:
- worker-05 goes dark first
- worker-00 then worker-01, ~20s apart
- control-00 last
- the Pi shuts down after them
- the UPS clicks off

**Step 5:** Restore mains. Verify all four nodes power on unattended (BIOS
setting from Task 0.4), and the Pi comes back.

**Step 6:** After boot, verify no node hung on the way down:

```sh
# Use IPs, not hostnames: control-00's /etc/hosts has no worker-05 entry.
for h in 192.168.2.84 192.168.2.204 192.168.2.117 192.168.2.164; do
  echo "== $h"; ssh szkud@$h 'journalctl -b -1 -o short-precise | tail -8'
done
kubectl get nodes
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```
Expected: `Reached target ...` / `Syncing filesystems` and no
`libceph ... error -101` storm; all nodes `Ready`; Ceph back to quorum 3/3 with
all PGs `active+clean` (still `HEALTH_ERR` from the cephx key warning; that is
expected and not a regression).

**Step 7:** Restore the real `START-TIMER cluster-shutdown <tuned value>` from
the Task 1.6 worksheet and restart `nut-monitor`.

---

### Task 3.5: Independent Matrix notification from the Pi

**Objective:** Get an alert that **survives the cluster going down**. This is
the only notification path that still works once the k3s nodes are off, and it
is the one you will actually be reading during an outage.

**Why this is separate from the cluster's alerting.** `matrix-alertmanager-receiver`
already runs in `observability` and routes to the `mercury` room — that is
excellent for trend alerts (battery aging, load creep) but it is *inside the
thing being shut down*. Wave 3 powers off control-00, and from that moment the
cluster cannot tell you anything, including that it shut down successfully. The
Pi posts straight to continuwuity's client-server API with `curl`, so it needs
no Python, no matrix SDK, and no cluster.

**Prerequisite decision — reachability.** During an outage the Pi must reach
continuwuity, which runs *in the cluster you are switching off*. Two honest
consequences:

- Messages sent at ONBATT and at shutdown-start **do** get through; the cluster
  is still up at that point. These are the messages that matter most.
- A message sent *after* wave 3 will fail. So the orchestrator posts its
  "starting shutdown" message **first**, and the final "all waves complete"
  message is best-effort.

If you want an alert that works even when the cluster is fully dark, the
notifier must target something off-cluster (a hosted Matrix homeserver, or
ntfy.sh). Decide which you want; the script below supports either via
`MATRIX_HOMESERVER`.

**Step 1:** Create a dedicated Matrix user for the Pi. On continuwuity, register
a user (e.g. `@ups-nut:gregbob.net`), log in once to obtain an access token, and
invite it to the **mercury** room.

```sh
curl -s -XPOST 'https://matrix.gregbob.net/_matrix/client/v3/login' \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"ups-nut"},"password":"<PASSWORD>"}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["access_token"])'
```

> **The mercury room must stay unencrypted.** The existing
> `matrix-alertmanager-receiver` config already states this: the bridge has no
> E2EE support and an encrypted room swallows every alert. This `curl` notifier
> has the same limitation, for the same reason.

**Step 2:** Store the credentials on the Pi, root-readable only.

```sh
sudo tee /etc/nut/matrix-notify.env >/dev/null <<'EOF'
MATRIX_HOMESERVER=https://matrix.gregbob.net
MATRIX_TOKEN=<ACCESS_TOKEN>
MATRIX_ROOM=!Sfg0hDmKySOk6uzvatx3Q7nz6YkHQBneFPtmY38zs9Y
EOF
sudo chmod 600 /etc/nut/matrix-notify.env
sudo chown root:root /etc/nut/matrix-notify.env
```

The room ID above is `mercury`, copied from the receiver's ConfigMap on `main`.
Note continuwuity's room IDs are bare hashes with no `:server` suffix; that is
correct, not truncated.

**Step 3:** Create `/usr/local/sbin/ups-notify`.

```sh
#!/bin/sh
# Post a message to Matrix directly from the NUT Pi.
#
# Deliberately dependency-free (curl + sh only) and deliberately fail-soft:
# a notification failure must NEVER abort the shutdown sequence, so every
# path exits 0. Timeouts are short because this runs on battery.
set -u
MSG="${1:-UPS event}"
ENV_FILE=/etc/nut/matrix-notify.env
LOG_TAG=ups-notify

[ -r "$ENV_FILE" ] || { logger -t "$LOG_TAG" "no $ENV_FILE; skipping notify"; exit 0; }
# shellcheck disable=SC1090
. "$ENV_FILE"

HOST="$(hostname -s)"
BODY="[$HOST] $MSG"

# Random txn id so retries are not deduplicated by the server.
TXN="$(date +%s)$$"

ESCAPED=$(printf '%s' "$BODY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')

if curl -sS --max-time 10 -XPUT \
  "${MATRIX_HOMESERVER}/_matrix/client/v3/rooms/${MATRIX_ROOM}/send/m.room.message/${TXN}" \
  -H "Authorization: Bearer ${MATRIX_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"msgtype\":\"m.text\",\"body\":${ESCAPED}}" >/dev/null 2>&1
then
  logger -t "$LOG_TAG" "notified: $MSG"
else
  logger -t "$LOG_TAG" "NOTIFY FAILED (continuing anyway): $MSG"
fi
exit 0
```

```sh
sudo install -m 0750 -o root -g root ups-notify /usr/local/sbin/ups-notify
```

**Step 4: Verify** — this posts a real message to mercury.

```sh
sudo /usr/local/sbin/ups-notify "test message from the NUT Pi, ignore"
journalctl -t ups-notify -n 5 --no-pager
```
Expected: the message appears in the mercury room, and the journal shows
`notified:`. If it shows `NOTIFY FAILED`, check the token and that the room is
unencrypted.

**Step 5: Verify fail-soft behaviour** — the important property.

```sh
sudo mv /etc/nut/matrix-notify.env /etc/nut/matrix-notify.env.bak
sudo /usr/local/sbin/ups-notify "should not crash"; echo "rc=$?"
sudo mv /etc/nut/matrix-notify.env.bak /etc/nut/matrix-notify.env
```
Expected: `rc=0`. A broken notifier must never block a shutdown.

---

# Phase 4: Cluster-side monitoring (the GitOps part)

Everything below lands in `federationspace/biggs-sz` on a feature branch and
merges to `main`. Nothing is applied with `kubectl` — Flux reconciles it.

### Task 4.1: Create the 1Password item

**Objective:** Prerequisite for the ExternalSecret. This is a manual step; if
the item does not exist, the secret never materialises and the pod stays
`CreateContainerConfigError`.

**Step 1:** In 1Password vault **`biggs-sz`**, create a **Login** item named
`nut-exporter` with:
- `username` = `exporter`
- `password` = `<EXPORTER_PASS>` (the value from Task 1.4 Step 6)

**Step 2: Verify** (requires the op CLI with desktop-app integration enabled):

```sh
op item get nut-exporter --vault biggs-sz --fields username
```

---

### Task 4.2: Create the ExternalSecret

**Files:** Create `clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/nut-exporter-externalsecret.yaml`

```yaml
# Materialises secret "nut-exporter-credentials" (keys: username, password),
# consumed by the nut-exporter Deployment as NUT_EXPORTER_USERNAME /
# NUT_EXPORTER_PASSWORD to authenticate against upsd on the NUT Pi.
#
# 1Password item required (biggs-sz vault):
#   - nut-exporter (Login) -- username "exporter", password matching the
#     [exporter] stanza in /etc/nut/upsd.users on nut-00. That account is
#     read-only: no instcmds, no upsmon role, so a leak cannot shut anything
#     down, only read UPS telemetry.
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: nut-exporter-credentials
  namespace: observability
  labels:
    app.kubernetes.io/name: nut-exporter
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: onepassword-connect
  target:
    name: nut-exporter-credentials
    creationPolicy: Owner
  data:
    - secretKey: username
      remoteRef:
        key: nut-exporter
        property: username
    - secretKey: password
      remoteRef:
        key: nut-exporter
        property: password
```

---

### Task 4.3: Create the Deployment and Service

**Files:**
- Create `clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/nut-exporter-deployment.yaml`
- Create `clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/nut-exporter-service.yaml`

Deployment:

```yaml
---
# Prometheus exporter for the NUT server on the Raspberry Pi (nut-00). It
# connects OUT of the cluster over TCP 3493 to upsd and republishes UPS
# telemetry for vmagent.
#
# IMPORTANT scope note: this is health/trending telemetry only. It is NOT part
# of the emergency shutdown path -- during an actual outage this pod is one of
# the things being shut down. The authoritative outage logic lives entirely on
# the Pi (/usr/local/sbin/nut-cluster-shutdown), which needs nothing from this
# cluster to work.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nut-exporter
  namespace: observability
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: nut-exporter
  template:
    metadata:
      labels:
        app: nut-exporter
    spec:
      containers:
        - name: nut-exporter
          image: docker.io/druggeri/nut_exporter:3.3.0
          env:
            - name: NUT_EXPORTER_SERVER
              value: "<PI_IP>"
            - name: NUT_EXPORTER_SERVERPORT
              value: "3493"
            - name: NUT_EXPORTER_USERNAME
              valueFrom:
                secretKeyRef:
                  name: nut-exporter-credentials
                  key: username
            - name: NUT_EXPORTER_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: nut-exporter-credentials
                  key: password
            # Superset of the defaults; adds runtime and temperature, which the
            # alert rules below depend on. Trim if the UPS does not report them
            # (check `upsc apc` output from Task 1.4 Step 9).
            - name: NUT_EXPORTER_VARIABLES
              value: "battery.charge,battery.runtime,battery.voltage,battery.voltage.nominal,input.voltage,input.voltage.nominal,output.voltage,ups.load,ups.status,ups.temperature"
          ports:
            - name: http
              containerPort: 9199
              protocol: TCP
          livenessProbe:
            httpGet:
              path: /metrics
              port: http
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /metrics
              port: http
            initialDelaySeconds: 5
            periodSeconds: 15
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              memory: 64Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 65534
            capabilities:
              drop: ["ALL"]
```

Service:

```yaml
---
apiVersion: v1
kind: Service
metadata:
  name: nut-exporter
  namespace: observability
  labels:
    app: nut-exporter
spec:
  type: ClusterIP
  selector:
    app: nut-exporter
  ports:
    - name: http
      port: 9199
      targetPort: http
      protocol: TCP
```

> `/metrics` is the exporter's own process telemetry and needs no `ups` param,
> which is why the probes can use it. The UPS data lives at `/ups_metrics?ups=apc`
> and is what the scrape config targets.

---

### Task 4.4: Create the VMServiceScrape

**File:** Create `clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/vmservicescrape.yaml`

```yaml
---
# Scrape nut_exporter into VictoriaMetrics. vmagent runs with
# selectAllByDefault: true, so this is picked up with no vmagent changes --
# same mechanism as ai-system/vllm's VMServiceScrape.
#
# The exporter REQUIRES the ups name in the query string: it errors the scrape
# if it sees more than one UPS and is not told which. Hence the params block.
#
# Key series:
#   network_ups_tools_battery_charge          -- percent
#   network_ups_tools_battery_runtime         -- SECONDS remaining
#   network_ups_tools_ups_load                -- percent of nominal
#   network_ups_tools_ups_status{flag="OL"}   -- 1 when on line power
#   network_ups_tools_ups_status{flag="OB"}   -- 1 when on battery
#   network_ups_tools_ups_status{flag="LB"}   -- 1 when low battery
#   network_ups_tools_ups_status{flag="RB"}   -- 1 when battery needs replacing
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMServiceScrape
metadata:
  name: nut-exporter
  namespace: observability
  labels:
    app.kubernetes.io/name: nut-exporter
spec:
  selector:
    matchLabels:
      app: nut-exporter
  endpoints:
    - port: http
      path: /ups_metrics
      interval: 30s
      params:
        ups: ["apc"]
```

---

### Task 4.5: Create the VMRule alerts

**File:** Create `clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/vmrule.yaml`

```yaml
---
# Alerting rules for the UPS, evaluated by vmalert (observability/stack runs
# selectAllByDefault: true, so this is auto-discovered).
#
# CAVEAT worth knowing before trusting these: alertmanager's default receiver
# is matrix-mercury, so these alerts DO reach the mercury room. But the
# receiver pod runs in this cluster -- during a real outage it is one of the
# things being shut down, so the later stages of an event are NOT reported
# here. The Pi's own ups-notify (Task 3.5) is the path that survives.
#
# Severity routing already exists in the alertmanager config on main:
# severity=critical gets group_wait 10s / repeat 4h; severity=info|none is
# blackholed. The severities below are chosen to fit that routing.
#
# Second caveat: during a real outage the cluster is being shut down, so these
# alerts stop firing partway through by design. The Pi's own syslog and
# /var/log/nut-cluster-shutdown.log are the authoritative post-mortem record.
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata:
  name: nut-exporter
  namespace: observability
  labels:
    app.kubernetes.io/name: nut-exporter
spec:
  groups:
    - name: ups
      rules:
        # The exporter cannot reach upsd, or the pod is down. This means the
        # cluster is BLIND to UPS state -- the Pi may still be protecting it,
        # but you would not know. Treat as urgent.
        - alert: UpsExporterDown
          expr: 'up{job=~".*nut-exporter.*"} == 0'
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "NUT exporter is down -- UPS state unknown"
            description: "nut_exporter has not been scrapable for 5m. Either the pod is failing or upsd on the NUT Pi (nut-00) is unreachable on TCP 3493. Check `systemctl status nut-server` on the Pi."

        # Mains lost. Not yet an emergency: the Pi's upssched timer is running
        # and will start the ordered shutdown if this persists.
        - alert: UpsOnBattery
          expr: 'network_ups_tools_ups_status{flag="OB"} == 1'
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "UPS on battery"
            description: "Mains power has been lost for 1m. The NUT Pi will begin the ordered cluster shutdown when its ONBATT timer expires."

        # The UPS itself has declared low battery. The orchestrator's LOWBATT
        # path fires immediately at this point; shutdown is in progress.
        - alert: UpsLowBattery
          expr: 'network_ups_tools_ups_status{flag="LB"} == 1'
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "UPS low battery -- cluster shutdown in progress"
            description: "The UPS has signalled LB. The NUT Pi should be executing the ordered shutdown now (worker-05, then worker-00/worker-01, then control-00)."

        # Runtime headroom below the time the ordered shutdown actually needs.
        # TUNE 420s to match the Task 1.6 worksheet total.
        - alert: UpsRuntimeBelowShutdownBudget
          expr: "network_ups_tools_battery_runtime < 420"
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "UPS runtime below the cluster shutdown budget"
            description: "Estimated runtime has been under 7 minutes for 2m, which is less than the measured time needed to shut the cluster down in order. Either load has grown or the battery has degraded. Re-run the discharge test."

        # Battery aging. Chronic, not acute -- but it is the thing that turns a
        # working UPS into a decorative one.
        - alert: UpsBatteryNeedsReplacement
          expr: 'network_ups_tools_ups_status{flag="RB"} == 1'
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "UPS reports battery needs replacement"
            description: "The UPS has raised the RB flag. Replace the battery; runtime is no longer trustworthy."

        # Charge not recovering after an outage suggests a failing battery or a
        # charger fault.
        - alert: UpsBatteryNotCharging
          expr: 'network_ups_tools_ups_status{flag="OL"} == 1 and network_ups_tools_battery_charge < 90'
          for: 6h
          labels:
            severity: warning
          annotations:
            summary: "UPS on line power but battery below 90% for 6h"
            description: "The UPS has been on mains for 6h without reaching 90% charge. Suspect a failing battery or charger."

        # Overload: at high load, runtime collapses non-linearly and the whole
        # budget calculation stops being valid.
        - alert: UpsLoadHigh
          expr: "network_ups_tools_ups_load > 80"
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "UPS load above 80%"
            description: "Sustained load above 80% of nominal. Runtime at this load is much shorter than the nameplate figure; re-measure the shutdown budget or move a device off the UPS."
```

---

### Task 4.6: Create the Flux Kustomization and register the app

**Files:**
- Create `clusters/cluster0/kubernetes/apps/observability/nut-exporter/ks.yaml`
- Modify `clusters/cluster0/kubernetes/apps/observability/kustomization.yaml`

`ks.yaml` (copies the sibling `grafana-operator`/`victoria-metrics` style exactly):

```yaml
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: &app nut-exporter
  namespace: flux-system
spec:
  targetNamespace: observability
  commonMetadata:
    labels:
      app.kubernetes.io/name: *app
  path: ./clusters/cluster0/kubernetes/apps/observability/nut-exporter/app
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  # wait: false -- the Deployment cannot become Ready until the NUT Pi is
  # actually up and reachable on 3493. Do not let a hardware prerequisite that
  # lives outside this repo block the observability namespace from reconciling.
  wait: false
  interval: 3m
  retryInterval: 1m
  timeout: 2m
```

Register it in the namespace kustomization:

```yaml
---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  # Pre Flux-Kustomizations
  - ./namespace.yaml
  # Flux-Kustomizations
  - ./victoria-logs/ks.yaml
  - ./victoria-metrics/ks.yaml
  - ./grafana-operator/ks.yaml
  - ./nut-exporter/ks.yaml
```

**Validation (offline, per the repo's convention — there is no CI):**

```sh
cd ~/biggs-sz
kubectl kustomize clusters/cluster0/kubernetes/apps/observability
echo "rc=$?"
```
Expected: `rc=0` and the rendered output includes the `nut-exporter`
Kustomization.

Because per-app dirs have no inner `kustomization.yaml`, render-check the leaf
manifests with a synthesized one:

```sh
TMP=$(mktemp -d)
cp clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/*.yaml "$TMP"/
cat > "$TMP/kustomization.yaml" <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - nut-exporter-deployment.yaml
  - nut-exporter-service.yaml
  - nut-exporter-externalsecret.yaml
  - vmservicescrape.yaml
  - vmrule.yaml
EOF
kubectl kustomize "$TMP" >/dev/null && echo LEAF_RENDER_OK
rm -rf "$TMP"
```
Expected: `LEAF_RENDER_OK`

Cross-reference check (names/ports/selectors must line up):

```sh
ruby -ryaml -e '
dir = "clusters/cluster0/kubernetes/apps/observability/nut-exporter/app"
docs = Dir["#{dir}/*.yaml"].flat_map { |f| YAML.load_stream(File.read(f)) }.compact
dep = docs.find { |d| d["kind"] == "Deployment" }
svc = docs.find { |d| d["kind"] == "Service" }
scr = docs.find { |d| d["kind"] == "VMServiceScrape" }
es  = docs.find { |d| d["kind"] == "ExternalSecret" }
c   = dep["spec"]["template"]["spec"]["containers"][0]
puts "pod labels:      #{dep["spec"]["template"]["metadata"]["labels"]}"
puts "svc selector:    #{svc["spec"]["selector"]}"
puts "scrape selector: #{scr["spec"]["selector"]["matchLabels"]}"
puts "containerPort:   #{c["ports"][0]["containerPort"]} (#{c["ports"][0]["name"]})"
puts "svc port:        #{svc["spec"]["ports"][0]["port"]} -> #{svc["spec"]["ports"][0]["targetPort"]}"
puts "scrape port:     #{scr["spec"]["endpoints"][0]["port"]} path=#{scr["spec"]["endpoints"][0]["path"]} params=#{scr["spec"]["endpoints"][0]["params"]}"
puts "secret ref:      #{es["spec"]["target"]["name"]}"
puts "env secret refs: #{c["env"].select { |e| e["valueFrom"] }.map { |e| e["valueFrom"]["secretKeyRef"]["name"] }.uniq}"
'
```
Expected: pod labels, service selector and scrape selector all `{"app"=>"nut-exporter"}`;
containerPort 9199 named `http`; service 9199 → `http`; scrape port `http`,
path `/ups_metrics`, params `{"ups"=>["apc"]}`; secret name matches the env refs.

**Commit:**

```sh
git checkout -b feat/nut-exporter
git add clusters/cluster0/kubernetes/apps/observability/nut-exporter \
        clusters/cluster0/kubernetes/apps/observability/kustomization.yaml
git commit -m "feat(observability): add nut-exporter for UPS telemetry"
```

---

### Task 4.7: Add the Grafana dashboard

**File:** Modify `clusters/cluster0/kubernetes/apps/observability/grafana-operator/app/helmrelease.yaml`

Add to the `dashboards.default` map, matching the existing entries' style:

```yaml
        nut-ups:
          # renovate: depName="Prometheus NUT Exporter for DRuggeri"
          gnetId: 19308
          revision: 4
          datasource: VictoriaMetrics
```

Verified against grafana.com: dashboard 19308 is "Prometheus NUT Exporter for
DRuggeri", current revision **4** (updated 2025-10-27, ~11.7k downloads). It is
built for exactly the `network_ups_tools_*` metric names this exporter emits.

**Verify:**

```sh
kubectl kustomize clusters/cluster0/kubernetes/apps/observability >/dev/null && echo OK
```

**Commit:**

```sh
git add clusters/cluster0/kubernetes/apps/observability/grafana-operator/app/helmrelease.yaml
git commit -m "feat(grafana): add NUT UPS dashboard"
```

---

### Task 4.8: Write the runbook

**File:** Create `docs/runbooks/ups-power-loss.md`

Content to cover:
- Topology diagram: which device is on which UPS outlet bank.
- The wave order and *why* (mon layout, control-00's NFS/ZFS role), cross-linking `node-reboot.md`.
- The tuned timer values and the Task 1.6 worksheet numbers they came from.
- Where the Pi's config and logs live (`/etc/nut/`, `/var/log/nut-cluster-shutdown.log`).
- How to test safely (`DRY_RUN=1`) and how to test for real.
- Per-node BIOS auto-power-on setting names and locations (Task 0.4 Step 3).
- Recovery: expected ~7 min POST per node, `kubectl get nodes`, `ceph -s`.
- The k3s-upgrade caveat: `kubelet.conf.d/` is managed by k3s and may be reset
  by an upgrade, silently disarming Phase 0. Re-check after every k3s upgrade.
- Battery replacement procedure and the `RB` alert.

**Commit and open the PR:**

```sh
git add docs/runbooks/ups-power-loss.md
git commit -m "docs(runbooks): add UPS power loss runbook"
git push -u origin feat/nut-exporter
gh pr create --title "feat(observability): NUT UPS monitoring" --body-file /tmp/pr-body.md
```

Write the PR body to a file first — heredocs inside `$(...)` break on unbalanced
parens.

---

### Task 4.9: Verify reconciliation after merge

**Step 1:** Confirm the merge actually happened before claiming anything is live.

```sh
gh pr view <n> --json state,mergeCommit
git fetch origin && git ls-tree -r origin/main --name-only | grep nut-exporter
```

**Step 2:** Force a reconcile (no `flux` CLI needed):

```sh
kubectl annotate gitrepository flux-system -n flux-system \
  reconcile.fluxcd.io/requestedAt="$(date +%s)" --overwrite
kubectl annotate kustomization nut-exporter -n flux-system \
  reconcile.fluxcd.io/requestedAt="$(date +%s)" --overwrite
kubectl get kustomization nut-exporter -n flux-system \
  -o jsonpath='{.status.lastAppliedRevision}{"\n"}'
```

**Step 3: Verify** the pod and the metrics.

```sh
kubectl -n observability get pods -l app=nut-exporter
kubectl -n observability get externalsecret nut-exporter-credentials
kubectl -n observability logs -l app=nut-exporter --tail=30
```
Expected: pod `Running`, ExternalSecret `SecretSynced`. A
`CreateContainerConfigError` means Task 4.1's 1Password item is missing or
misnamed.

**Step 4:** Confirm the scrape landed, via the vmsingle query API:

```sh
kubectl -n observability port-forward svc/vmsingle-stack 8428:8428 &
curl -sG 'http://localhost:8428/api/v1/query' \
  --data-urlencode 'query=network_ups_tools_battery_charge' | python3 -m json.tool
curl -sG 'http://localhost:8428/api/v1/query' \
  --data-urlencode 'query=network_ups_tools_ups_status{flag="OL"}' | python3 -m json.tool
```
Expected: a result with a numeric value (charge ~100, OL == 1).

**Step 5:** Open https://grafana.gregbob.net and confirm the NUT dashboard
renders live data.

---

## Files likely to change

**In this repo (new):**
```
clusters/cluster0/kubernetes/apps/observability/nut-exporter/ks.yaml
clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/nut-exporter-deployment.yaml
clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/nut-exporter-service.yaml
clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/nut-exporter-externalsecret.yaml
clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/vmservicescrape.yaml
clusters/cluster0/kubernetes/apps/observability/nut-exporter/app/vmrule.yaml
docs/runbooks/ups-power-loss.md
```

**In this repo (modified):**
```
clusters/cluster0/kubernetes/apps/observability/kustomization.yaml
clusters/cluster0/kubernetes/apps/observability/grafana-operator/app/helmrelease.yaml
```

**Host-level, outside Git (no config management exists for these):**
```
nut-00:   /etc/nut/{nut,ups,upsd,upsd.users,upsmon,upssched}.conf
          /etc/nut/upssched-cmd
          /usr/local/sbin/nut-cluster-shutdown
          /usr/lib/systemd/system-shutdown/nutshutdown
          /root/.ssh/nut_shutdown{,.pub}
all 4 nodes: /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf
             /etc/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf
             /etc/nut/{nut,upsmon}.conf
             /etc/sudoers.d/nutshutdown
             /home/nutshutdown/.ssh/authorized_keys
```

---

## Risks and tradeoffs

**The Pi is a single point of failure.** If it dies mid-outage, the ordered
shutdown never runs. Mitigation is the Phase 2 secondary `upsmon` on each node,
which still saves them at `LB` — unordered, but with Phase 0's graceful kubelet
shutdown that is survivable. Accepting this is the price of not running a second
UPS-attached host.

**Host config drifts and nobody notices.** None of the Pi or node configuration
is in Git, by explicit choice. The specific landmine: a k3s upgrade can reset
`kubelet.conf.d/`, silently removing the graceful-shutdown config that the whole
design rests on, and you will only find out during the next real outage. The
runbook must call this out, and it is worth a periodic manual check. If this
becomes annoying, the honest fix is Ansible for the host layer, which is a
larger commitment than this plan.

**Timer values are guesses until measured.** Every `START-TIMER` and `WAIT`
number in Phase 3 is a placeholder. Task 1.6 and Task 0.3 produce the real ones.
Shipping the placeholders is how you discover during a blackout that the
battery died in wave 2.

**The monitoring cannot observe its own emergency.** The exporter runs inside
the cluster being shut down, so the Grafana view goes dark partway through a
real event. This is fine as long as it is understood: the Pi's local log is the
post-mortem record. Anything that must survive the cluster has to run on the Pi.

**Cluster alerts stop mid-event, by construction.** Alertmanager's default
receiver is `matrix-mercury`, so UPS `VMRule`s do reach the mercury room — but
the receiver pod is inside the cluster being shut down. Expect the Matrix
thread to go quiet partway through a real outage. Task 3.5's Pi-side notifier
is what covers the gap; the two are complementary, not redundant.

**Only 5 of the BX1500M's 10 outlets are battery-backed**, and six devices need
protection. Task 1.3 resolves this with a strip for the two small loads (Pi +
switch), but it is the single most likely thing to get quietly wrong during a
rack reshuffle months from now, and the failure is invisible until an outage.
The runbook's outlet table exists for exactly this reason.

**Brief blips cause a full shutdown if the timer is too aggressive.** A 30-second
flicker should not take down the cluster; the `AT ONLINE * CANCEL-TIMER` rule
handles that, but only if the ONBATT timer is longer than typical blip duration.
Err long, subject to the runtime budget.

**Consumer Back-UPS units drop their USB link.** "Data stale" / "Driver not
connected" is a well-documented failure across the APC Back-UPS line. The
`pollinterval 15` + `MAXAGE 25` pairing in Task 1.4 is the standard mitigation,
and `DEADTIME 15` on the Pi means a genuine dead UPS is still caught. If it
recurs anyway, `UpsExporterDown` and the `commbad` notifier will tell you
before it matters.

---

## Open questions

1. **Does the BX1500M report `battery.runtime`?** Two alerts and the runtime
   budget depend on it. Consumer Back-UPS units sometimes expose only
   `battery.charge`. Settled by `upsc apc` at Task 1.4 Step 9; if absent, swap
   `UpsRuntimeBelowShutdownBudget` to a charge-percentage threshold.
2. **Which outlet strategy for the 6-devices-into-5-outlets problem?** The plan
   recommends a plain (non-surge) strip carrying the Pi and the switch on one
   battery outlet. Confirm that matches what you actually want to wire.
3. **Should the Pi's notifier target an off-cluster destination?** As written it
   posts to continuwuity, which is *in* the cluster; messages land at ONBATT and
   shutdown-start but not after wave 3. A hosted homeserver or ntfy.sh would
   survive a fully dark cluster. Worth deciding before Task 3.5.
4. **Are the waves right, or should workers go in parallel?** The 3-wave order
   is the conservative reading of the runbook. If Task 1.6 shows a tight runtime
   budget, collapsing waves 1 and 2 is the first thing to cut — Phase 0's
   graceful shutdown makes simultaneous worker shutdown much safer than it was
   on 2026-08-28, but it has not been proven on this hardware.
6. **Does anything else belong on the UPS?** The user scoped this to the four
   k3s nodes. Non-cluster hosts, the router, and the NAS-adjacent gear were
   explicitly not included, but they share the same battery and eat the same
   runtime.
