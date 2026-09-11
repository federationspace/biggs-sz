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

From memory, the repo, and `docs/runbooks/node-reboot.md`:

| Fact | Value |
|---|---|
| Nodes | `control-00` 192.168.2.164, `worker-00` 192.168.2.204, `worker-01` 192.168.2.117, `worker-05` 192.168.2.84 |
| Ceph mons | `mon-a` = control-00, `mon-d` = worker-01, `mon-f` = worker-00. **worker-05 has no mon.** |
| control-00 special | k3s control plane, NFS server (exports to itself over 192.168.2.32), ZFS `tank` pool, mon-a. Must shut down **last**. |
| SSH | LAN uses port **22** (port 20252 is external only and is refused on-LAN) |
| control-00 journal | user is not in `adm`/`systemd-journal`; `dmesg_restrict=1`. Fix this early (Task 0.1) or you cannot diagnose the test reboots. |
| POST time | ~7 min per node. Normal, not a hang. Matters for recovery expectations, not the shutdown budget. |
| Observability | VictoriaMetrics k8s stack (`vmagent` `selectAllByDefault: true`), Grafana via `grafana-operator`, alertmanager enabled but routed to a `blackhole` receiver |
| Secrets | External Secrets + ClusterSecretStore `onepassword-connect`, 1Password vault `biggs-sz` |

**Assumptions to confirm before starting:**
- The APC model is USB-attached and speaks HID Power Device Class (nearly all
  modern Back-UPS/Smart-UPS do). Exact model determines `battery.charge.low`
  granularity and whether `battery.runtime` is reported at all.
- The Pi, **the network switch**, and all four nodes are on *battery-backed*
  outlets, not the surge-only bank. If the switch is on surge-only, the Pi
  loses its path to the nodes the instant mains drops and the entire design
  fails silently.
- All four nodes' BIOS/UEFI is set to **power on after AC loss** (see Task 0.4).

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

**Step 1:** Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager.
In the Imager's advanced options set: hostname `nut-00`, enable SSH with your
public key, set locale/timezone, and configure Wi-Fi only as a fallback — this
box must be on **Ethernet**.

**Step 2:** Prefer a USB SSD over an SD card if one is spare. This device will
be writing logs during every power event and SD cards are the usual failure
point in a box whose entire job is to be alive when everything else is not.

**Step 3:** Boot, then:

```sh
ssh nut-00.local   # or the DHCP address
sudo apt update && sudo apt full-upgrade -y && sudo reboot
```

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

**Step 1:** Connect the UPS's USB-B port to a USB-A port on the Pi.

**Step 2:** **Outlet audit.** On the battery-backed bank: all four nodes, the
Pi, and the network switch. On the surge-only bank: nothing that matters. Write
down which device is in which outlet.

> If the switch is not battery-backed, the Pi cannot SSH to the nodes during an
> outage and the orchestrator is dead weight. Verify this physically; do not
> assume from the manual.

**Step 3: Verify** the Pi sees the device.

```sh
lsusb | grep -i american
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
[apc]
    driver = usbhid-ups
    port = auto
    vendorid = 051d
    desc = "APC UPS - biggs-sz rack"
    pollfreq = 15
    # offdelay/ondelay: ondelay MUST be greater than offdelay on APC units or
    # the driver refuses to start. These control the UPS power-cycle at the end
    # of the shutdown sequence; ondelay is the wait before power returns.
    offdelay = 60
    ondelay = 120
```

**Step 4:** Start the driver alone first, before anything else. This is where
model incompatibilities surface.

```sh
sudo upsdrvctl start
```
Expected: `Using subdriver: APC HID 0.xx` and no errors. A permissions error
here means the udev rules did not apply; `sudo udevadm control --reload && sudo udevadm trigger`, then replug the USB cable.

**Step 5:** `/etc/nut/upsd.conf` — listen on the LAN, not just loopback.

```ini
LISTEN 127.0.0.1 3493
LISTEN <PI_IP> 3493
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
# Wave order is deliberate and derives from docs/runbooks/node-reboot.md:
#   wave 1: worker-05  -- holds NO Ceph mon, so it can leave without touching quorum
#   wave 2: worker-00, worker-01 -- mon-f and mon-d; staggered so quorum with
#           mon-a survives while each flushes its RBD volumes
#   wave 3: control-00 -- mon-a + NFS server + ZFS tank + k3s control plane.
#           Everything else depends on it; it must be the last box standing.
#
# Each node's kubelet holds a 180s systemd inhibitor lock and evicts pods /
# unmounts volumes before the network dies (Phase 0). We therefore do NOT run
# `kubectl drain` here: it needs a working API server, adds minutes we do not
# have on battery, and the inhibitor already does the important half.
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
case "$1" in
  cluster-shutdown|cluster-shutdown-now)
    logger -t upssched-cmd "NUT: sustained outage ($1) -- starting ordered cluster shutdown"
    /usr/local/sbin/nut-cluster-shutdown
    ;;
  power-restored)
    logger -t upssched-cmd "NUT: mains restored, cluster shutdown timer cancelled"
    ;;
  commbad)
    logger -t upssched-cmd "NUT: lost communication with the UPS for 60s"
    ;;
  replbatt)
    logger -t upssched-cmd "NUT: UPS reports the battery needs replacement"
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
# CAVEAT worth knowing before trusting these: alertmanager in this cluster
# currently routes everything to the "blackhole" receiver, so these fire but
# notify nobody. See the open question in the plan about adding a Matrix
# receiver via continuwuity. Until then these are visible in the vmalert UI and
# Grafana only.
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

**Alerts currently go nowhere.** Alertmanager routes to `blackhole`. Every
`VMRule` in Task 4.5 will fire correctly into vmalert and Grafana and notify
nobody. Worth fixing, but it is a separate change.

**Brief blips cause a full shutdown if the timer is too aggressive.** A 30-second
flicker should not take down the cluster; the `AT ONLINE * CANCEL-TIMER` rule
handles that, but only if the ONBATT timer is longer than typical blip duration.
Err long, subject to the runtime budget.

---

## Open questions

1. **Exact APC model?** It determines whether `battery.runtime` is reported (the
   `UpsRuntimeBelowShutdownBudget` alert and the LOWBATT logic depend on it),
   what `battery.charge.low` values the unit accepts, and the real runtime
   ceiling. Run `upsc apc` at Task 1.4 Step 9 and revisit the timers.
2. **Is the network switch on a battery-backed outlet?** If not, the entire
   orchestration path is dead the moment mains drops. This needs a physical
   check, not an assumption.
3. **Should alertmanager get a real receiver?** The cluster runs continuwuity in
   the `matrix` namespace; routing UPS alerts to a Matrix room would make them
   actually useful, and would work from a phone during an outage. Out of scope
   here, but this plan is a good reason to do it.
4. **Should the Pi notify independently of the cluster?** During an outage the
   cluster is going down, so cluster-based alerting cannot tell you what
   happened. A small push notification from the Pi (ntfy, Matrix, e-mail) at
   ONBATT/shutdown would be the only alert that survives the event.
5. **Are the waves right, or should workers go in parallel?** The 3-wave order
   is the conservative reading of the runbook. If Task 1.6 shows a tight runtime
   budget, collapsing waves 1 and 2 is the first thing to cut — Phase 0's
   graceful shutdown makes simultaneous worker shutdown much safer than it was
   on 2026-08-28, but it has not been proven on this hardware.
6. **Does anything else belong on the UPS?** The user scoped this to the four
   k3s nodes. Non-cluster hosts, the router, and the NAS-adjacent gear were
   explicitly not included, but they share the same battery and eat the same
   runtime.
