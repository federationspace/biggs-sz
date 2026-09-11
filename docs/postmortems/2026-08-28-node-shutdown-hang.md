# Postmortem: cluster0 node shutdown hang

- **Incident date:** 2026-08-28
- **Diagnosed and remediated:** 2026-09-11
- **Affected:** `control-00`, `worker-05`
- **Impact:** two nodes required manual power-cycling to complete a reboot. No
  data loss; Ceph returned to `active+clean` each time.
- **Status:** resolved and verified by three undrained test reboots. Two
  unrelated issues found along the way remain open.

---

## Summary

A routine reboot of all four cluster nodes left `control-00` and `worker-05`
stuck late in shutdown. Both had to be power-cycled by hand.

The cause was **network-backed storage outliving the network**. k3s ships with
kubelet's graceful node shutdown explicitly *disabled*, so kubelet did nothing
when the machines were told to power down. It left Ceph RBD and NFS mounts for
`systemd-shutdown` to untangle after networking had already stopped, at which
point the flushes could never complete.

Enabling kubelet graceful node shutdown on all four nodes fixed it. Three
subsequent undrained reboots, including the control plane, completed with no
human intervention and zero Ceph errors.

---

## Timeline

| Time (2026-08-28) | Event |
|---|---|
| 20:15:58 | worker-00 down; `mon-f` leaves |
| 20:17:19 | worker-01 down; `mon-d` leaves, **Ceph quorum now 1/3** |
| 20:17:38 | worker-05 kernel: `mon0 session lost, hunting for new mon` |
| 20:17:42 | worker-05 reboot issued, into a cluster with no Ceph quorum |
| 20:18:04 | worker-05 reaches `reboot.target` normally (22s) |
| 20:18:06 | worker-05 kernel: `libceph: connect ... error -101` (ENETUNREACH), journald already stopped |
| — | **worker-05 hangs; manual power cycle** |
| 20:36 | control-00 down last, holding `mon-a` |
| — | **control-00 hangs; manual power cycle** |

The nodes' own dark-gap history is what made the hang visible:

| Node | Historical | 2026-08-28 | Verdict |
|---|---|---|---|
| worker-00 | 4.8 - 7.2 min | 7.2 min | normal |
| worker-01 | 7.3 - 7.4 min | 7.4 min | normal |
| **worker-05** | 0.6 - 9.0 min | **17.3 min** | **hung** |
| **control-00** | ~4 min | **~17 min** | **hung** |

---

## Root cause

Three factors compounded.

### 1. k3s actively disables graceful node shutdown

`/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/00-k3s-defaults.conf`, which k3s
regenerates on every start, contains:

```yaml
shutdownGracePeriod: 0s
shutdownGracePeriodCriticalPods: 0s
```

This is the direct cause. Kubelet was configured to do nothing on shutdown, so
`k3s.service` (`KillMode=process`, stops in ~1s) exited and handed every RBD and
NFS reference to `systemd-shutdown`.

### 2. Reboot order destroyed Ceph mon quorum

Mons are `a`=control-00, `d`=worker-01, `f`=worker-00. Two of three were rebooted
before worker-05 began shutting down, so its RBD flush had no quorum to talk to
and retried into `ENETUNREACH` forever.

### 3. control-00 additionally serves NFS to itself

`192.168.2.32` is control-00's own NIC (`enp2s0f0`); its cluster identity is
`192.168.2.164`. It runs `nfs-server` *and* mounts that export back over the
loopback path, with `hard` semantics, while also hosting `mon-a` and the `tank`
ZFS pool.

### Contributing: worker-05 hardware

Found during remediation, see open items. worker-05 throttles continuously from
overheating, which plausibly explains why it in particular was slow enough to hit
the deadlock, and why its historical dark gaps were so erratic.

---

## Permanent changes made

All host-level, applied by hand on **all four nodes**. There is no config
management for the host layer in this repo, so these are not reconciled by Flux
and will not self-heal.

### 1. Kubelet graceful node shutdown

**File (new), every node:**
`/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf`

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
shutdownGracePeriod: 180s
shutdownGracePeriodCriticalPods: 60s
```

The `10-` prefix matters: it must sort *after* k3s's `00-k3s-defaults.conf` to
override `shutdownGracePeriod: 0s`.

### 2. logind inhibitor ceiling

**File (new), every node:**
`/etc/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf`

```ini
[Login]
InhibitDelayMaxSec=180
```

**The filename is deliberate and must not be "tidied".** Ubuntu ships
`/usr/lib/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf` with
`InhibitDelayMaxSec=30`. Per `man 5 logind.conf`, drop-ins from `/usr/lib` and
`/etc` are sorted **together by filename regardless of directory**, last wins.
A conventionally-named `10-inhibit-delay.conf` sorts *before* `unattended-*` and
would be **silently ignored**. Reusing the vendor filename in `/etc/` masks it,
which is the documented way to override a package drop-in.

`InhibitDelayMaxSec` must be `>=` `shutdownGracePeriod` or the shorter value wins.

### Verified state (2026-09-11)

| Node | kubelet drop-in | logind drop-in | `InhibitDelayMaxUSec` | kubelet lock |
|---|---|---|---|---|
| control-00 | yes | yes | `t 180000000` | held |
| worker-00 | yes | yes | `t 180000000` | held |
| worker-01 | yes | yes | `t 180000000` | held |
| worker-05 | yes | yes | `t 180000000` | held |

### Not a permanent change

A one-off SQLite backup of the k3s datastore was taken before the control-00
reboot and copied off-node. Note for future work: **this cluster uses the
embedded SQLite/kine datastore, not etcd.** `k3s etcd-snapshot save` fails with
`etcd datastore disabled`. The `db/etcd/` directory is a vestigial stub; the real
data is `db/state.db` (333M, ~157k rows). Back it up with the SQLite online
backup API, not `cp` (there is a ~545MB WAL, so a plain copy can tear).

---

## Verification

Three undrained reboots. Draining first was deliberately avoided: it empties the
node and therefore hides the mechanism under test, and a real power event will
not drain either.

| Node | Pods | Ceph role | Dark gap | libceph errors | Intervention |
|---|---|---|---|---|---|
| worker-01 | 21 | mon-d, osd.1 | 20.1s | 0 | none |
| worker-00 | 40 | mon-f, osd.0, 5 CNPG primaries | 20.1s | 0 | none |
| control-00 | 78 | mon-a, NFS server, ZFS | 169s | 0 | none |
| worker-05 | 24 | osd.2 | n/a | 0 | **power button** |

Kubelet behaviour on control-00, the hardest case:

```
"Node became not ready" reason="KubeletNotReady" message="node is shutting down"
436 x UnmountVolume.TearDown succeeded
191 x "Pod admission denied" reason="NodeShutdown"
Stopped rpc-statd / nfs-mountd / nfs-client.target
Unmounted tank-media.mount, tank.mount
Reached target reboot.target
```

Zero `libceph ... error -101` during any power-down, versus a storm on 2026-08-28.

**The loopback-NFS risk did not materialise**, for two reasons confirmed on the
node: all 34 of control-00's NFS and RBD mounts are kubelet-managed (under
`/var/lib/kubelet/`), so the inhibitor covers them; and `nfs-server` has
`DefaultDependencies=no` with no `Conflicts=shutdown.target`, so systemd does not
stop it early.

---

## What we got wrong along the way

Recorded because each cost time and could mislead again.

- **"These boxes have a ~7 minute POST."** They do not. A healthy node returns in
  ~20s. The multi-minute gaps *were the bug*, and an early baseline table
  enshrined the symptom as normal.
- **"`InhibitDelayMaxSec` defaults to 5s, so set `10-inhibit-delay.conf`."** The
  effective value was 30s from an unattended-upgrades vendor drop-in, and that
  filename would have lost the sort and been silently ignored.
- **"Gate reboots on Ceph `HEALTH_OK`."** Unreachable on this cluster: the sole
  `[ERR]` is `AUTH_INSECURE_SERVICE_KEY_TYPE`, a squid cephx `aes` key
  deprecation unrelated to storage safety. Gate on quorum and PG state instead.
- **"The datastore is etcd."** It is SQLite/kine.
- **"The 180s pause is kubelet doing work."** It is unattended-upgrades holding
  the lock until forcibly timed out; kubelet finishes in seconds.

---

## Open items

### 1. worker-05 hardware thermal fault (blocking for UPS automation)

Console on reboot: `warning: system has recovered from an over-temperature
condition`. At idle:

| Node | CPU | pkg temp | PCH | throttle events/hr |
|---|---|---|---|---|
| control-00 | Xeon E5-2620 v4 | 42 C | - | 0 |
| worker-00 | i7-1360P | 51 C | - | 0 |
| worker-01 | Core 3 100U | 46 C | - | 0 |
| **worker-05** | **i5-8259U (28W mobile)** | **92 C** | **95 C** | **~20,717** |

1889 throttle events in its first two minutes of uptime, still throttling ~2/sec
while idle, running a Ceph OSD on a 28W laptop-class chip. Its shutdown sequence
is clean; it simply cannot complete a power cycle unattended.

Likely physical: dust-clogged heatsink, dried thermal paste, or airflow. **This
blocks the NUT UPS plan**, whose wave 1 assumes worker-05 powers off on command.

### 2. control-00 wastes 2 minutes per boot on an unplugged NIC

```
Startup finished in 14.995s (kernel) + 2min 39.070s (userspace)
2min 139ms  systemd-networkd-wait-online.service   <- 76% of boot
```

`/etc/netplan/00-installer-config.yaml` declares `dhcp4: true` on all four NICs;
`enp1s0f0` has no cable, so networkd blocks the full 120s timeout and the unit
ends `failed`. Fix is `optional: true` on that interface, or removing it. Not
applied: control-plane networking deserves its own window.

### 3. unattended-upgrades now costs ~3 min per reboot

Raising `InhibitDelayMaxSec` to 180s extended *its* window from 30s too. Matters
for the UPS runtime budget. Either stop the service before an orchestrated
shutdown, or give it a shorter per-service cap. Do **not** lower
`InhibitDelayMaxSec` below `shutdownGracePeriod`; that re-breaks kubelet.

### 4. Cosmetic: NodeShutdown pod tombstones

Each graceful shutdown leaves `Failed`/`NodeShutdown` pod records (90 after
worker-00, 172 after control-00, mostly `cilium-operator`) from the ReplicaSet
retrying placement during the window. Harmless; clear with
`kubectl delete pods -A --field-selector status.phase=Failed`. Count scales with
the inhibitor window, so fixing item 3 shrinks it.

### 5. Pre-existing, untouched

`ai-system` pods Pending/CrashLoop (missing GPU infrastructure),
`netbird-client` CrashLoopBackOff on the three workers, and Ceph `MON_DISK_LOW`
(control-00 root 75% full; mon-a's data is only 74M, so this is really a
filesystem-usage warning).

---

## Follow-ups worth doing

1. Fix worker-05's cooling, then re-test an unattended reboot. Gates the UPS work.
2. Apply the netplan `optional: true` one-liner during a maintenance window.
3. Decide how to cap unattended-upgrades before arming NUT.
4. **Re-check both drop-ins after every k3s upgrade.** k3s regenerates
   `00-k3s-defaults.conf`; it does not touch `10-graceful-shutdown.conf`, so this
   should survive, but the directory is k3s-managed and worth verifying.
5. Consider host-level config management. These changes are hand-applied and
   invisible to Git, which is exactly how they will drift.

## References

- `docs/runbooks/node-reboot.md` — operational procedure and verification commands
- `.hermes/plans/2026-09-05_143000-nut-ups-raspberry-pi-graceful-shutdown.md` —
  NUT UPS plan; its Phase 0 is satisfied by this work
