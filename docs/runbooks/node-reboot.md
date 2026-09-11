# Runbook: rebooting cluster0 nodes safely

Written after the 2026-08-28 reboot, where `control-00` and `worker-05` both
hung in late shutdown and had to be recovered the hard way.

> **Status as of 2026-09-11: Fix 2 is APPLIED on all four nodes and verified by
> live reboot test.** `InhibitDelayMaxSec=180` and kubelet's shutdown inhibitor
> lock are confirmed present cluster-wide. Fixes 1 and 4 are procedure. Fix 3
> (control-00 loopback NFS) is untouched and unproven; it only gets exercised
> when control-00 itself reboots.
>
> Two undrained reboot tests on 2026-09-11 confirmed the original failure is
> gone. See "Verification results" below, including a **hardware fault on
> worker-05** found during testing.

## Why nodes hang on reboot

Both stuck nodes were holding **network-backed storage that outlived the
network**. systemd itself shut down cleanly and reached `reboot.target`; the
hang happened afterwards, inside `systemd-shutdown`, once journald was already
dead. That is why there is no log of it.

worker-05's last kernel messages, two seconds after journald stopped:

```
systemd-shutdown[1]: Syncing filesystems and block devices.
systemd-shutdown[1]: Sending SIGTERM to remaining processes...
kernel: libceph: connect (2)192.168.2.164:3300 error -101   <- ENETUNREACH
kernel: libceph: ceph_tcp_connect failed: -101
kernel: libceph: mon0 (2)192.168.2.164:3300 connect error
```

Three factors compound:

1. **Reboot order destroyed Ceph mon quorum.** Mons are `a`=control-00,
   `d`=worker-01, `f`=worker-00. Two of three were rebooted before worker-05
   started shutting down, so its RBD flush could never complete.
2. **k3s leaves the mounts behind.** Both units are `KillMode=process` with no
   kubelet graceful shutdown configured. k3s stops in about a second and hands
   every RBD and NFS reference to `systemd-shutdown` to untangle after the
   network is gone.
3. **control-00 additionally deadlocks on loopback NFS.** It is both NFS server
   and NFS client of itself; see below.

## Fix 1: reboot in quorum-safe order (do this every time)

Never reboot two mon hosts in a row. Check quorum between each node, and drain
first so volumes are unmounted while the network still works.

```sh
# Where the mons actually are, right now. Do not assume.
kubectl -n rook-ceph get pods -o wide | grep -E 'mon-|osd-'

# Confirm quorum is 3/3 and all PGs are active+clean BEFORE starting.
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

For each node, one at a time:

```sh
NODE=worker-05

kubectl drain "$NODE" --ignore-daemonsets --delete-emptydir-data --timeout=10m

# Wait for Ceph to be healthy again with the OSD out, before touching the box.
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s

ssh "$NODE" sudo systemctl reboot

# Wait for it to come back and settle, then:
kubectl uncordon "$NODE"
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

Order matters: **reboot control-00 last**, and only once every worker is back
`Ready` with quorum restored. It hosts mon-a, the NFS export, and the ZFS pool;
if it goes down first, everything else loses its storage backend mid-shutdown.

The dark-gap numbers below are from the 2026-08-28 incident, when Fix 2 was not
yet applied. **Treat the "normal" column as historical, not as a target:** with
graceful shutdown in place, worker-01 came back in **20.1s** (see "Verification
results"). The multi-minute gaps were stalled shutdowns, not POST time.

| Node | Dark gap 2026-08-28 | Then-current baseline |
|---|---|---|
| worker-00 | 7.2 min | 4.8 - 7.2 min |
| worker-01 | 7.4 min | 7.3 - 7.4 min |
| **worker-05** | **17.3 min** | 0.6 - 9.0 min |
| **control-00** | **~17 min** | ~4 min |

## Fix 2: enable kubelet graceful node shutdown

This is the real fix for factor 2. It makes kubelet take a systemd inhibitor
lock, evict pods, and unmount volumes *before* the network goes away.

k3s already passes `--config-dir=/var/lib/rancher/k3s/agent/etc/kubelet.conf.d`,
and ships its own `00-k3s-defaults.conf` in that directory which contains:

```yaml
shutdownGracePeriod: 0s
shutdownGracePeriodCriticalPods: 0s
```

**k3s actively disables graceful node shutdown**; it is not merely unset. That is
the direct cause of the 2026-08-28 behaviour: kubelet was configured to do
nothing on shutdown. Our file must therefore sort *after* `00-*`, hence the `10-`
prefix. k3s regenerates `00-k3s-defaults.conf` on start but does not touch our
file, so this survives a k3s restart; still re-check after a k3s upgrade.

Drop this in on **every node**:

`/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf`

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
shutdownGracePeriod: 180s
shutdownGracePeriodCriticalPods: 60s
```

**The critical half that is easy to miss:** systemd-logind only honours an
inhibitor lock up to `InhibitDelayMaxSec`. The compiled-in default is 5s, but on
these nodes Ubuntu's `unattended-upgrades` package already ships a vendor drop-in
that raises it to **30s**:

```
/usr/lib/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf
InhibitDelayMaxSec=30
```

30s is still far below the 180s grace period, so it would silently truncate the
shutdown. You must raise it, and **the filename matters**.

Drop-ins across `/usr/lib/systemd/*.conf.d/` and `/etc/systemd/*.conf.d/` are
sorted together by filename in lexicographic order, *regardless of which
directory they live in*, and the last one wins. A file named
`10-inhibit-delay.conf` sorts **before** `unattended-upgrades-logind-maxdelay.conf`
and therefore **loses**. Verified against `man 5 logind.conf` on the node:

> Files in the `*.conf.d/` configuration subdirectories are sorted by their
> filename in lexicographic order, regardless of in which of the subdirectories
> they reside. When multiple files specify the same option [...] the entry in the
> file sorted last takes precedence.

Use one of these two instead:

**Option A (recommended), mask the vendor file by reusing its exact name.** A
file in `/etc/` with the same name as a vendor file in `/usr/lib/` overrides it
outright, which is the documented way to override a package drop-in:

`/etc/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf`

```ini
[Login]
InhibitDelayMaxSec=180
```

**Option B, sort last.** Any name that sorts after `unattended-*` works, e.g.
`/etc/systemd/logind.conf.d/zz-inhibit-delay.conf` with the same contents. This
is more fragile: a future package drop-in named later in the alphabet would
silently win again.

Either way, 180s also satisfies unattended-upgrades, which only wanted a floor
of 30s.

Then, per node:

```sh
sudo systemctl restart systemd-logind
sudo systemctl restart k3s        # or k3s-agent on workers
```

`InhibitDelayMaxSec` must be **>= `shutdownGracePeriod`**, or the shorter value
wins and pods get killed mid-flush anyway.

Verify it took effect:

```sh
# Should report t 180000000, not t 30000000 (vendor default) or t 5000000
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 \
  org.freedesktop.login1.Manager InhibitDelayMaxUSec

# Kubelet should hold a delay lock named "kubelet"
systemd-inhibit --list | grep -i kubelet
```

### Caveat

`/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/` is managed by k3s and may be
reset by a k3s upgrade. Re-check this file after upgrading k3s. There is no
host-level config management in this repo, so this is a manual, per-node change
that Flux will not restore for you.

## Fix 3: control-00's loopback NFS

control-00 is both the NFS server and an NFS client of itself. `192.168.2.32`
is its own NIC (`enp2s0f0`); its cluster identity is `192.168.2.164`.

Current state:

- 11 RBD devices
- 8 `hard` NFS mounts from `192.168.2.32:/`, its own address
- `nfs-server` active locally
- hosts mon-a and the `tank` ZFS pool

When nfsd is torn down during shutdown, `hard` mounts retry forever against a
server that no longer exists. This is the classic loopback-NFS shutdown
deadlock, stacked on top of the Ceph problem worker-05 had.

Seven media pods on control-00 mount `media-pvc` this way: `epub-only`,
`lidarr`, `radarr`, `readarr`, `romm`, `sabnzbd`, `sonarr`. The PV is
`clusters/cluster0/kubernetes/apps/media/media-storage/app/media-pv.yaml`.

**Do not switch the mount to `soft`.** It trades a hang for silent write
corruption on a media library. Keep `hard`.

Options, in order of preference:

1. **Fix 2 largely resolves this.** With graceful shutdown, pods terminate and
   volumes unmount while nfsd is still running. Do this first and re-test.
2. **Give control-00-local pods a local volume instead.** Since control-00 *is*
   the NAS and `/tank` is local to it, routing its own pods over loopback NFS
   buys nothing but latency and this deadlock. A `local` PV pinned to control-00
   would remove the loopback entirely. The tradeoff is real: `media-pvc` is RWX
   and shared across nodes, so this means splitting the volume story between
   control-00 and the workers, not a one-line change.
3. **Pin the media pods to workers.** Simplest, but it defeats the deliberate
   design of staging downloads locally on the NAS and moving them to the ZFS
   pool without crossing the 1GbE link.

I would do 1, verify with a test reboot, and only take on 2 if it still hangs.

## Fix 4: Ceph is unhealthy right now

Independent of reboots. Current state:

```
HEALTH_ERR
  [ERR] AUTH_INSECURE_SERVICE_KEY_TYPE: 4 auth service entities with insecure key types
        osd.0, osd.1, osd.2, mgr.a using insecure key type: aes
  [WRN] AUTH_INSECURE_CLIENT_KEY_TYPE: 8 auth client entities
  [WRN] AUTH_INSECURE_KEYS_ALLOWED / AUTH_INSECURE_KEYS_CREATABLE
  [WRN] MON_DISK_LOW: mon a is low on available space (25% avail)
```

**Do not gate the reboot on `HEALTH_OK`; you will wait forever.** The single
`[ERR]` is `AUTH_INSECURE_SERVICE_KEY_TYPE`, which is a Ceph 19.2.x (squid)
deprecation notice about `aes` cephx key types on the OSDs and mgr. It is a key
rotation task, entirely unrelated to shutdown safety, and it will keep the
cluster at `HEALTH_ERR` until the keys are rotated. That is separate work.

What actually matters before a reboot is **quorum and PG state**, not the
top-line health string:

```sh
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

Gate on: `mon: 3 daemons, quorum a,d,f`, `osd: 3 up, 3 in`, and all PGs
`active+clean`. All three are currently true, so the cluster is safe to reboot
despite `HEALTH_ERR`.

`MON_DISK_LOW` is worth clearing but is less alarming than it first looks.
mon-a's data lives on a `hostPath` at `/var/lib/rook/mon-a` on control-00's root
filesystem, which is 75% full (31G free); the mon data itself is only 74M. The
warning tracks free space on `/`, so it is really "control-00's root filesystem
is filling up", not "Ceph is running out of room". Readable offenders are
`/var/log` at 2.1G (1.2G of which is journal) and `/var/lib/rancher` at 897M;
`du` undercounts as a non-root user, so check with sudo before concluding.
`journalctl --vacuum-size=200M` is the easy win.

## Verification results (2026-09-11)

Fix 2 was applied to all four nodes and tested with **undrained** reboots. Not
draining is deliberate: a drain empties the node first and therefore hides the
very mechanism under test, and a real power event will not drain either.

### worker-01, the clean benchmark

21 pods running, including `mon-d` and `osd.1`. Rebooted with no drain and no
human intervention:

```
22:01:16.159  "Node became not ready" reason="KubeletNotReady"
              message="node is shutting down"                        (+0.0s)
22:01:17.857  "Pod admission denied" reason="NodeShutdown"
22:04:16      Delay lock is active (PID 836/unattended-upgr)
              but inhibitor timeout is reached
22:04:18.569  Reached target reboot.target
22:04:18.621  systemd-shutdown[1]: Syncing filesystems and block devices.
```

| Measure | Result |
|---|---|
| Time to go dark | 183.6s |
| **Dark gap (power-off to responding)** | **20.1s** |
| libceph errors during shutdown | **0** |
| Human intervention | **none** |

**The 20.1s dark gap is the headline number.** The "~7 minute POST" in the table
above was never POST; it was the machine sitting in a stalled shutdown. A
healthy node on this hardware is back in about 20 seconds.

### The 180s is unattended-upgrades, not kubelet

Both test reboots showed the same thing: `systemd-logind` reports the delay lock
held by **`unattended-upgr`**, not kubelet, and times it out at exactly 180s.
Kubelet marks the node NotReady within ~25ms and finishes its work in seconds.

So raising `InhibitDelayMaxSec` to 180s also extended *unattended-upgrades'*
window from 30s to 180s. That is a real cost of roughly 3 minutes added to every
reboot, and it matters for the UPS battery budget in the NUT plan. Options, if
that becomes a problem:

```sh
# Before a planned reboot:
sudo systemctl stop unattended-upgrades
```

Do not lower `InhibitDelayMaxSec` below `shutdownGracePeriod` to solve this; that
re-breaks kubelet. A per-service cap for unattended-upgrades is the correct fix
if one is needed.

### worker-05 has a hardware thermal fault

worker-05 could not complete either test unassisted and needed a physical power
button press both times. The console showed:

```
warning: system has recovered from an over-temperature condition
```

Thermal comparison across the cluster, all at or near idle:

| Node | CPU | pkg temp | PCH | throttle events/hr |
|---|---|---|---|---|
| control-00 | Xeon E5-2620 v4 | 42 C | - | **0** |
| worker-00 | i7-1360P (13th gen) | 51 C | - | **0** |
| worker-01 | Core 3 100U | 46 C | - | **0** |
| **worker-05** | **i5-8259U (28W mobile)** | **92 C** | **95 C** | **~20,717** |

worker-05 accumulated 1889 throttle events in its first two minutes of uptime and
continues throttling at roughly 2/second while essentially idle. It runs a Ceph
OSD plus general workload on a 28W laptop-class chip.

This is very likely a contributing cause of the original 2026-08-28 incident, not
merely a coincidence found later. Two pieces of prior evidence fit:

- worker-05's Aug 28 log contains
  `workqueue: ceph_con_workfn [libceph] hogged CPU for >10000us 1024 times`
- its historical dark gaps were wildly erratic (0.6, 8.1, 3.5, 9.0, 17.3 min),
  which is what a machine throttling to a crawl looks like

Both things are true at once: the storage deadlock was the *mechanism*, and
thermal throttling is plausibly why worker-05 was the node slow enough to hit it.

**This is physical and unresolved.** Likely causes are a dust-clogged heatsink or
fan, dried thermal paste, or inadequate case airflow. Until it is fixed, treat
worker-05 as unable to reboot unattended and expect a console and a power button
to be needed. Getting worker-05 to reboot cleanly on its own is tracked as
separate work.

Quick check on any node:

```sh
cat /sys/class/thermal/thermal_zone*/type /sys/class/thermal/thermal_zone*/temp
cat /sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count
```

A non-zero, *increasing* throttle count on an idle node means the hardware is
overheating.

## Verifying a node actually shut down cleanly

After the next reboot, confirm PID 1 reached the end:

```sh
journalctl -b -1 -o short-precise | tail -20
```

You want to see `Reached target reboot.target` followed by
`systemd-shutdown[1]: Syncing filesystems and block devices.` and then nothing
alarming. Repeated `libceph ... connect error -101` after that line means the
node hung again.

Live check for the signature failure, a blocked journal thread on an RBD volume:

```sh
ps -eo stat,pid,comm | awk '$1 ~ /^D/'
```

A `jbd2/rbdN-8` in `D` state, with high load average against mostly idle CPU, is
this bug reproducing.

## Note on journal access

`control-00`'s system journal could not be read during the investigation. The
user there is in `sudo` but not in `adm` or `systemd-journal`, so `journalctl`
silently returns only user-session entries, and `kernel.dmesg_restrict=1` blocks
`dmesg`. The workers have `adm` and are fine.

To make control-00 diagnosable without a password prompt:

```sh
sudo usermod -aG adm,systemd-journal szkud   # then log out and back in
```

## Access gotchas

**SSH ports differ by path.** On the LAN, nodes listen on **22**; port 20252 is
refused. From outside, only `69.61.172.135:20252` is forwarded, and it lands on
control-00. Reach the workers by hopping through control-00.

**control-00 cannot resolve `worker-05`.** `/etc/hosts` has entries for
worker-00 and worker-01 only, so `ssh worker-05` fails with "Temporary failure in
name resolution". Use `192.168.2.84` directly, or add the missing line:

```sh
echo '192.168.2.84   worker-05' | sudo tee -a /etc/hosts
```

Any script that loops over nodes by hostname from control-00 will silently skip
worker-05; use IPs in automation.
