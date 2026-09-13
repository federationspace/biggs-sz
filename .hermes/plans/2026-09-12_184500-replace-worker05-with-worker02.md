# Replace worker-05 with worker-02 (GMKtec NucBox K17) Implementation Plan

**Goal:** Retire the thermally-faulted `worker-05` and bring up `worker-02` on a
GMKtec NucBox K17, reusing worker-05's NVMe as the root disk and the K17's stock
NVMe as the Ceph OSD, returning cluster0 to `HEALTH_OK` with three OSD hosts.

**Architecture:** Fresh Ubuntu Server 24.04 LTS install onto worker-05's carried-
over NVMe, HWE kernel for Lunar Lake, join to k3s as an agent pinned to
`v1.34.3+k3s1`, then add the node's second NVMe to the Rook Ceph cluster via Git.
All cluster-side changes go through a PR to `main`; Flux reconciles.

**Reusable procedure:** `docs/runbooks/add-cluster-node.md` (written alongside
this plan). This file is the worker-05-specific instance of that runbook.

---

## Status log

**2026-09-13, pre-flight boot for clean detach — DONE.** worker-05 was booted
deliberately to let kubelet release three RWO Ceph volumes that had been stuck
`attached=True` for 7.5h. Outcome:

- Guards set first: `kubectl cordon worker-05`, `ceph osd set noin`,
  `ceph osd set nobackfill`. **`noin` mattered:** `ceph osd dump` showed osd.2
  carrying the `autoout` flag, so it would have been re-marked `in` on boot and
  pulled ~140 GiB of backfill onto the disk about to be pulled. The node was
  also never actually cordoned before this, only carrying `unreachable` taints,
  which clear the moment it goes `Ready`.
- The RBD CSI nodeplugin crash-looped twice on boot
  (`failed to get node "worker-05": dial tcp 10.43.0.1:443: i/o timeout`) because
  Cilium had not finished programming the service map. It self-healed on the
  next restart; no intervention needed.
- **All three volumes detached.** `renovate/renovate-config` and
  `ai-system/hermes-data` recovered on their own (renovate now `1/1 Running` on
  worker-00, hermes `Running` on control-00). 23 pods that had been wedged
  `Terminating` cleared without `--force`.
- `git-system/gitea-shared-storage` detached, but **gitea is still `Pending`**,
  blocked solely by its `nodeSelector`. Storage is no longer the blocker. This is
  fixed by PR 1, Task 1.3, with no hardware involved.
- Drive SMART captured (see below), node powered off.

**Still outstanding, unchanged:** osd.2 is still in the CRUSH map (not purged),
the `worker-05` Node object still exists, and `noin`/`nobackfill` are **still
set**. Those flags stay until worker-02 has a real OSD, and are cleared in
Phase 4, not before.

**Amendment to Task 1.4:** the stranded local-path PVC deletions and the
force-delete loop are now largely moot; the pods terminated cleanly. Re-check
what actually remains before running that step rather than running it blind.

**2026-09-13, Phase 1 (PR #152) — DONE and merged.** osd.2 purged,
`worker-05` removed from the CRUSH map, both Git references dropped. The CRUSH
tree is now two hosts (`worker-00`, `worker-01`), the `worker-05` Node object is
deleted, and the stale `rook-ceph-osd-2` Deployment plus
`rook-ceph-osd-prepare-worker-05` Job were removed by hand (Rook does not garbage
collect these). `noin`/`nobackfill` remain set, as intended.

Post-merge, reconciliation surfaced **three problems unrelated to worker-05.**
All three are now fixed, but they are latent repo/cluster bugs worth knowing
about before the next node swap:

1. **Cilium `ipv4NativeRoutingCIDR` was wrong.** Git declared
   `10.244.0.0/16` (the Flannel/kubeadm default) but this is k3s, whose pod CIDR
   is `10.42.0.0/16`. Because pod traffic fell outside the declared CIDR, Cilium
   SNAT'd cross-node pod traffic to the node IP, so it arrived with Cilium
   identity `remote-node` instead of the pod's own identity and was denied by the
   `flux-system` NetworkPolicies:

   ```
   xx drop (Policy denied) identity remote-node->120102:
   192.168.2.117:47846 -> 10.42.0.232:9090 tcp SYN
   ```

   This only bites namespaces that *have* NetworkPolicies, which is why the
   cluster looked healthy for months: `flux-system` has them because the
   `FluxInstance` sets `networkPolicy: true`. It surfaced only when the
   worker-05 eviction scattered the Flux controllers across nodes;
   kustomize-controller (worker-01) could no longer reach source-controller
   (control-00), so **every Kustomization froze at a stale revision.**
   **Still unfixed in Git** — see open items.

2. **`FluxInstance` had a floating version.** `spec.distribution.version: "2.x"`
   against flux-operator v0.41.1. `2.x` had drifted past the last good build
   (v2.8.8) to a release whose `Receiver` CRD layout the operator's built-in
   patch no longer matched, so the FluxInstance went `Stalled=True` with an
   `eventSources` enum error the moment it was next applied. Pinning the version
   cleared it. This was a time bomb that would have fired at the next hourly
   reconcile regardless of the node work.

3. **worker-01 hit `DiskPressure`, which took jellyfin offline.** Jellyfin's
   `jellyfin-cache` PVC is `local-path` with a 100Gi request, but **local-path
   does not enforce capacity** — the transcode directory had grown to **107.6 GiB
   across 4,100 orphaned segment files** on a 147 GiB root disk (88% full). The
   resulting `DiskPressure` evicted the `intel-gpu-plugin` DaemonSet pod, so
   worker-01 advertised `gpu.intel.com/i915: 0`, and jellyfin (which *requests* 1)
   became unschedulable cluster-wide. Clearing `transcodes/` took the disk from
   88% to 11%. Note kubelet takes ~5 minutes to clear the `DiskPressure`
   condition, and the evicted DaemonSet pod must be deleted by hand before the
   DaemonSet will replace it.

**Services restored:** gitea (`HelmRelease` green, pod `1/1` on control-00),
jellyfin (`1/1` on worker-01 with `/dev/dri` and `i915: 1`, `/health` = 200),
renovate, hermes. 11 evicted pods swept.

**Also repaired:** `gitea-valkey-cluster` had lost a master. The cluster is 3
masters with **no replicas**, and the one owning slots 5461-10922 lived on
worker-05 on `local-path` — unrecoverable from the moment the node died, and
Task 1.4's PVC deletion left node-1 booting with a blank `nodes.conf`. Repaired
in place with `CLUSTER MEET` + `CLUSTER FORGET` + reassigning the 5,462 orphaned
slots; `cluster_state:ok`, all 16384 slots covered. Only cache data was lost
(gitea sessions/queues); repos are on `ceph-block` and Postgres was healthy 3/3.

**Pre-existing failures, NOT caused by this work and still failing:** the
`ai-system` stack (agent-sandbox, kagent, vllm, and the ~10 Kustomizations
chained behind them via `dependsOn`). Those pods carry
`nodeSelector: nvidia.com/gpu.present: "true"` and **no node in this cluster has
an NVIDIA GPU**; their `lastTransitionTime` is 2026-08-20. Out of scope here.

---

## Current context

Verified live on 2026-09-12:

| Fact | Value |
| --- | --- |
| `worker-05` | `NotReady`, kubelet stopped posting status since 12:20 EDT |
| Its pods | ~19, most stuck `Terminating` (node gone, no kubelet to confirm unmount) |
| Ceph | `HEALTH_ERR`, `osd.2` down/out, 33 PGs `active+undersized+degraded` |
| Ceph capacity | 2 x 775 GiB up, 280 GiB used of 1.5 TiB, 42.34k objects, 156 GiB data |
| `osd.2` device | `/dev/vgroot/lvceph` (shares the physical disk with root) |
| Cluster nodes | `control-00` 192.168.2.164, `worker-00` .204, `worker-01` .117, `worker-05` .84 |
| k3s | `v1.34.3+k3s1` everywhere, agents run bare `k3s agent`, no flags, no config.yaml |
| apiserver | `https://192.168.2.32:6443` |
| OS fleet | Ubuntu 24.04.5 LTS, kernel 6.8.0-139-generic |
| CNPG | 6 of 7 clusters at 2/3 ready; the missing replica is the worker-05 one in each |
| Pinned to worker-05 in Git | `git-system/gitea` HelmRelease `nodeSelector`, and the rook-ceph `storage.nodes` entry |
| local-path PVs stranded on worker-05 | 8 (listed below) |

### Hardware

**Outgoing, worker-05:** Intel i5-8259U (28W mobile), 16 GiB RAM, 8 logical CPUs,
single NVMe carrying root + `vgroot/lvceph`. Documented hardware thermal fault:
throttles from boot, 1889 throttle events in the first two minutes, cannot
reboot unattended (`docs/runbooks/node-reboot.md`, open items).

**Incoming, GMKtec NucBox K17** (Micro Center SKU 710306):

- Intel Core Ultra 5 226V (Lunar Lake), 8 cores / 8 threads, 20/25/35W TDP modes
- Intel Arc 130V iGPU + AI Boost NPU
- 16 GB LPDDR5X, **onboard and not upgradable**
- 2 x M.2 slots: 1 x PCIe **Gen5 x4**, 1 x PCIe **Gen4 x2**. **No SATA support.**
- 1 x RJ45 2.5 GbE, Wi-Fi 6E, BT 5.2, USB4, 2 x HDMI 2.1

Net effect: same RAM, roughly double the usable CPU, a far better iGPU, 2.5 GbE
instead of 1 GbE, and no thermal fault.

### Decisions taken

1. **worker-05's NVMe becomes the root disk**, in the **Gen4 x2** slot.
2. **The K17's stock NVMe becomes the Ceph OSD**, in the **Gen5 x4** slot.
   OSD latency is what the cluster feels; the old node's OSD was the slow one
   partly because it shared a spindle with root.
3. **worker-02 gets the static IP 192.168.2.60**, configured on the host via
   netplan, not a DHCP reservation. This is a new address, not worker-05's old
   192.168.2.84, so there is no reservation to move and no conflict with the old
   box. Login is the standard fleet account.
4. **worker-05 may return later as a separate node.** It is therefore retired
   from the cluster but not scrapped. Its chassis will need a different disk
   before it is ever powered on again on this LAN. It still holds
   192.168.2.84, which worker-02 does not use.

### The carried-over drive (measured 2026-09-13, node booted for detach)

| Field | Value |
| --- | --- |
| Model / firmware | `PCIe SSD` (generic, unbranded), `ECFM22.7` |
| Serial | `20121410240044` |
| Capacity | 2000409264 x 512B = **1.02 TB** |
| PCIe link | **Gen3 x4** (8.0 GT/s, 4 lanes) |
| `media_errors` | **0** |
| `critical_warning` | 0 |
| `percentage_used` | 29% |
| `power_on_hours` | 37,412 (**4.3 years**) |
| `unsafe_shutdowns` | 106 |

**Verdict: healthy, reuse as root.** Zero media errors after 4.3 years is the
deciding number; 29% wear means a light write load, and root duty is lighter
still than the OSD duty it just finished.

**This drive is almost certainly the real cause of the "slow OSD".** The
HelmRelease comment blames `osd.2 on worker-05 (slowest NVMe, 24ms apply latency
vs 4-8ms on peers)` and attributes it to the node. But worker-00's OSD sits on a
**Samsung 980 PRO**; this is an unbranded Gen3 drive competing against Gen4
Samsungs. That gap follows the disk, not the chassis, and a new chassis will not
close it. It is the strongest argument for the slot assignment above: this drive
must **not** be the OSD again.

Consequence of the slot choice: a Gen3 x4 drive in a Gen4 **x2** slot negotiates
two lanes, roughly 2 GB/s. Irrelevant for a root disk.

### Assumptions to confirm before starting

- [x] worker-05's drive is NVMe, healthy, 1 TB. **Confirmed.** Still verify the
      2280 length physically fits the K17 standoff.
- [ ] The K17 as purchased actually ships with an SSD. The 710306 listing could
      not be scraped (Micro Center is behind a bot wall); GMKtec sells the K17 in
      16GB+512GB and 16GB+1TB trims. **Open the box and check.** If it is
      barebones, section "Contingency A" applies.
- [ ] Stock SSD capacity. At 512 GB the OSD is smaller than the two existing
      775 GiB OSDs. See "Ceph capacity" under Risks.
- [ ] **If the stock drive is also a budget/QLC part**, consider buying a decent
      Gen4 NVMe for the OSD slot rather than repeating the osd.2 latency story
      with a different no-name disk.

---

## Proposed approach

Fresh install, not a disk transplant boot. Carrying worker-05's installed OS
into the K17 would mean a 6.8 GA kernel on Lunar Lake: no `xe` driver for Arc
130V, likely no driver for the 2.5 GbE NIC (so no network and no way in), a
netplan file matching an interface name that no longer exists, and a stale
`machine-id` plus k3s node identity. The disk is being reused as *hardware*, not
as an installed system.

Phases:

1. Retire worker-05 cleanly from Kubernetes and Ceph (PR 1).
2. Build the K17 and install Ubuntu 24.04 LTS + HWE kernel.
3. Join as `worker-02`.
4. Add its OSD to Ceph (PR 2) and let it backfill.
5. Repoint or drop workload pins, rebuild replicas (PR 2 or 3).
6. Verify, including one tested drain-and-reboot cycle.

Two PRs, not one: Ceph must lose the old host before it gains the new one, and
the node has to exist before the OSD entry means anything.

---

## Step-by-step plan

### Phase 0: pre-flight

**Task 0.1: record current state**

```sh
kubectl get nodes -o wide
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl -n rook-ceph get pods -o wide | grep -E 'mon-|osd-'
kubectl get kustomizations -A | grep -v True
```

Expected now: `osd.2 down 0`, hosts `worker-00`/`worker-01`/`worker-05` in the
CRUSH tree, mons `a`, `d`, `f` in quorum on control-00 / worker-01 / worker-00
(confirm; mons move).

**Task 0.2: confirm mon quorum is 3/3 before touching anything**

worker-05 does not host a mon right now, which is why the cluster is degraded
rather than down. Do not begin if quorum is not 3/3.

**Task 0.3: back up anything single-copy on worker-05's local-path volumes**

Not possible: the node is unreachable, its kubelet is dead, and the pods are
`Terminating`. Accept the loss. The eight stranded volumes are all replicas of
replicated systems:

| Namespace | PVC | PV | Rebuild path |
| --- | --- | --- | --- |
| ai-system | `data-valkey-cluster-1` | `pvc-a73d20ea` | Valkey cluster resync |
| cnpg-system | `cnpg-gitea-1` | `pvc-d9a8a965` | CNPG re-clones from primary `cnpg-gitea-2` |
| cnpg-system | `cnpg-homarr-1` | `pvc-8c3f156d` | CNPG, primary `cnpg-homarr-2` |
| cnpg-system | `cnpg-pinepods-3` | `pvc-f2ca2575` | CNPG, primary `cnpg-pinepods-1` |
| cnpg-system | `cnpg-renovate-3` | `pvc-4f4ffc5d` | CNPG, primary `cnpg-renovate-1` |
| cnpg-system | `cnpg-romm-5` | `pvc-c27f2d75` | CNPG, primary `cnpg-romm-4` |
| cnpg-system | `cnpg-rreading-glasses-4` | `pvc-b6fba232` | CNPG, primary `cnpg-rreading-glasses-3` |
| git-system | `valkey-data-gitea-valkey-cluster-1` | `pvc-5d1b2aa8` | Valkey cluster resync |

Every CNPG primary is on `control-00` or `worker-00`, none on worker-05, so no
database loses its authoritative copy. Confirm that is still true at execution
time:

```sh
kubectl -n cnpg-system get clusters.postgresql.cnpg.io \
  -o custom-columns=NAME:.metadata.name,PRIMARY:.status.currentPrimary
```

If any primary has moved to worker-05, **stop** and fail it over first.

---

### Phase 1: retire worker-05 (PR 1)

**Task 1.1: drain**

```sh
kubectl drain worker-05 --ignore-daemonsets --delete-emptydir-data --timeout=10m
```

Expect this to time out or hang on the `Terminating` pods; the node is already
gone. That is fine, it still cordons.

**Task 1.2: purge osd.2 from Ceph**

```sh
T="kubectl -n rook-ceph exec deploy/rook-ceph-tools --"
$T ceph osd safe-to-destroy osd.2       # already out; expect "safe to destroy"
$T ceph osd purge 2 --yes-i-really-mean-it
$T ceph osd crush remove worker-05
$T ceph osd tree                        # worker-05 bucket gone
```

Cluster stays `undersized`, now with two hosts and no phantom third.

**Task 1.3: PR 1, remove worker-05 from Git**

Files:

- Modify `clusters/cluster0/kubernetes/apps/rook-ceph/rook-ceph/cluster/helmrelease.yaml`
  - Delete lines 106-108, the `worker-05` entry under `storage.nodes`.
  - Update the stale comments at lines 36-42 and 46-49, which reference
    "osd.2 on worker-05" as the reason for `timeoutSeconds: 30` and the
    `bdev_async_discard_threads` note. Keep the settings, reword the rationale
    as historical.
- Modify `clusters/cluster0/kubernetes/apps/git-system/gitea/app/helmrelease.yaml:223`
  - `nodeSelector: {kubernetes.io/hostname: worker-05}`. Gitea's storage is
    `ceph-block` (`global.storageClass`, `persistence.storageClass`), so this pin
    buys nothing. **Delete it** rather than repointing it to worker-02.

Validate before pushing:

```sh
kubectl kustomize clusters/cluster0/kubernetes/apps/rook-ceph
kubectl kustomize clusters/cluster0/kubernetes/apps/git-system
```

Commit, open PR, merge to `main`, then:

```sh
flux reconcile kustomization rook-ceph --with-source
kubectl get kustomizations -A | grep -v True
```

**Task 1.4: delete the node object and the stranded PVCs**

Order matters. Node last would leave pods wedged forever; node first leaves the
PVCs orphaned but deletable, which is the lesser evil and unavoidable here since
the kubelet is already dead.

```sh
kubectl delete node worker-05

for p in $(kubectl get pods -A -o json | jq -r \
  '.items[]|select(.spec.nodeName=="worker-05")|"\(.metadata.namespace)/\(.metadata.name)"'); do
  kubectl -n ${p%%/*} delete pod ${p##*/} --force --grace-period=0
done

kubectl -n ai-system   delete pvc data-valkey-cluster-1
kubectl -n git-system  delete pvc valkey-data-gitea-valkey-cluster-1
kubectl -n cnpg-system delete pvc cnpg-gitea-1 cnpg-homarr-1 cnpg-pinepods-3 \
                                  cnpg-renovate-3 cnpg-romm-5 cnpg-rreading-glasses-4
kubectl -n rook-ceph delete deploy rook-ceph-osd-2 --ignore-not-found
```

**Task 1.5: checkpoint**

```sh
kubectl get nodes                       # 3 nodes, all Ready
kubectl get pods -A | grep -v Running | grep -v Completed
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

Ceph will still be `undersized` (2 hosts, size 3). CNPG clusters will re-create
their third instance and may sit `Waiting for the instances to become active`
until there is a third node with capacity. Both resolve in Phase 4.

---

### Phase 2: build the K17

**Task 2.1: pull the drive from worker-05**

Power it down fully, unplug, remove the M.2 NVMe. Photograph the label, record
model and serial; you will identify it by serial later.

**Task 2.2: install both drives in the K17**

- worker-05's NVMe into the **PCIe Gen4 x2** slot. This is the root disk.
- The K17's stock NVMe into the **PCIe Gen5 x4** slot. This is the OSD disk.

If the stock drive is already populated in the Gen5 slot from the factory, leave
it and put the carried drive in the free slot; verify which is which after boot
via serial, not by `nvme0n1` / `nvme1n1` order.

**Task 2.3: BIOS**

- Restore on AC Power Loss: **Power On**
- Record the 2.5 GbE NIC MAC address
- Boot order: USB first for the install

**Task 2.4: prepare install media (on the Mac)**

```sh
shasum -a 256 ubuntu-24.04.5-live-server-amd64.iso
curl -s https://releases.ubuntu.com/24.04/SHA256SUMS | grep live-server-amd64
diskutil list
diskutil unmountDisk /dev/diskN
sudo dd if=ubuntu-24.04.5-live-server-amd64.iso of=/dev/rdiskN bs=4m status=progress
diskutil eject /dev/diskN
```

**Why 24.04 LTS and not something newer:** every other node runs 24.04.5. Same
distro, same kernel series, same package versions, same shutdown behaviour. The
graceful-shutdown work in `docs/runbooks/node-reboot.md` was verified against
exactly this combination.

**Task 2.5: install**

Installer answers: hostname **`worker-02`** (k3s takes the node name from it),
**static IP 192.168.2.60/24** (see Task 2.7 — you can set it in the installer's
network screen or apply netplan after first boot), OpenSSH server yes,
third-party drivers yes, no snaps, custom storage layout targeting **only** the
carried-over drive.

Root disk layout, mirroring worker-00 and worker-01:

- 1 GB EFI, `/boot/efi`
- 2 GB ext4, `/boot`
- remainder LVM PV in VG `ubuntu-vg`, root LV `ubuntu-lv` ext4 on `/`

**Leave the OSD disk completely untouched in the installer.** Rook wants it raw.

Note: worker-05's disk arrives with a `vgroot` VG containing the old `lvceph`.
The installer's "erase and use whole disk" on that target removes it. If you
land in a state where `vgroot` still exists, remove it explicitly before
continuing, since two VGs with LVs named similarly is a foot-gun:

```sh
sudo vgs
sudo vgremove -f vgroot
```

**Task 2.6: first boot, HWE kernel, storage packages**

```sh
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y linux-generic-hwe-24.04 linux-firmware
sudo apt install -y nfs-common open-iscsi lvm2
sudo systemctl enable --now iscsid
sudo reboot
```

**The HWE kernel is not optional on this box.** Lunar Lake needs the `xe` driver
and recent firmware for Arc 130V, and the 2.5 GbE controller may not be in 6.8
at all. The 24.04 GA kernel is 6.8; HWE brings 6.14.

Verify:

```sh
uname -r                 # expect 6.14.x
ip -br a                 # 2.5GbE up, holding 192.168.2.60
ls /dev/dri              # expect card0 + renderD128
lsblk -o NAME,SIZE,MODEL,SERIAL,FSTYPE,MOUNTPOINT
ls -l /dev/disk/by-id/nvme-* | grep -v part
```

Record the OSD disk's `by-id` path. You need it verbatim in Phase 4.

**Task 2.7: static IP**

worker-02 uses a **static address, 192.168.2.60/24** — not a DHCP reservation,
and not worker-05's old 192.168.2.84. Set it before joining, so the node never
changes address after k3s records it.

Confirm the interface name first; it will not be worker-05's. On Lunar Lake with
the 2.5 GbE NIC expect something like `enp1s0` or `enp2s0`:

```sh
ip -br link
```

Ubuntu's installer writes `/etc/netplan/50-cloud-init.yaml`. Replace its contents
(gateway and DNS confirmed live from worker-01):

```yaml
network:
  version: 2
  ethernets:
    <iface>:                       # e.g. enp1s0, from `ip -br link`
      dhcp4: false
      addresses:
        - 192.168.2.60/24
      routes:
        - to: default
          via: 192.168.2.1
      nameservers:
        addresses: [192.168.2.1]
```

```sh
sudo chmod 600 /etc/netplan/50-cloud-init.yaml   # netplan warns if world-readable
sudo netplan try                                  # auto-reverts in 120s if you lose the link
sudo netplan apply
ip -br a && ip route | head -2
```

Use `netplan try` rather than `apply` when working over SSH: a typo in the
address or gateway otherwise locks you out and forces a trip to the console.

If the installer also wrote a `99-*.yaml` or a cloud-init network config,
neutralise it, or cloud-init will reassert DHCP on the next boot:

```sh
echo 'network: {config: disabled}' | \
  sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
```

Reachability check from your workstation before continuing:

```sh
ping -c2 192.168.2.60 && ssh 192.168.2.60 'hostnamectl --static'   # expect worker-02
```

---

### Phase 3: join the cluster

**Task 3.1: get the join token**

```sh
ssh 192.168.2.164 'sudo cat /var/lib/rancher/k3s/server/node-token'
```

**Task 3.2: install the agent, version pinned**

```sh
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION=v1.34.3+k3s1 \
  K3S_URL=https://192.168.2.32:6443 \
  K3S_TOKEN='<token>' \
  sh -
```

The pin matters. Without `INSTALL_K3S_VERSION` the script takes current stable,
which would put an agent ahead of a `v1.34.3+k3s1` server.

**Task 3.3: apply the shutdown fixes**

These are host-level and not in Git. Both are mandatory.

`/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf`

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
shutdownGracePeriod: 180s
shutdownGracePeriodCriticalPods: 60s
```

`/etc/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf`

```ini
[Login]
InhibitDelayMaxSec=180
```

```sh
sudo systemctl restart systemd-logind
sudo systemctl restart k3s-agent

busctl get-property org.freedesktop.login1 /org/freedesktop/login1 \
  org.freedesktop.login1.Manager InhibitDelayMaxUSec   # expect t 180000000
systemd-inhibit --list | grep -i kubelet
```

The filename of the logind drop-in is load-bearing: drop-ins sort by filename
across `/usr/lib` and `/etc` together, last wins, and Ubuntu's
`unattended-upgrades` ships a file by that exact name setting 30s. Reusing the
name overrides it. A `10-` prefixed file would lose.

**Task 3.4: verify the join**

```sh
kubectl get nodes -o wide                                   # worker-02 Ready
kubectl get pods -A -o wide --field-selector spec.nodeName=worker-02
kubectl get node worker-02 --show-labels | tr ',' '\n' | grep feature.node
kubectl get node worker-02 -o jsonpath='{.status.capacity}' | jq
```

Expect self-service DaemonSets: `cilium`, `cilium-envoy`, NFD worker,
`intel-gpu-plugin`, rook discover, log/metric collectors. Nothing to apply.

`gpu.intel.com/i915` capacity depends on the plugin recognising Arc 130V under
`xe`. The NFD rule at
`kube-system/intel-gpu-plugin/app/nfd-intel-rules.yaml` already matches `xe` as
well as `i915`, so this should work, but treat GPU capacity as a bonus, not a
gate. Nothing currently pins a transcoding workload to worker-05; jellyfin is on
worker-01 and plex on worker-00.

**Task 3.5: control-00 `/etc/hosts`**

control-00 does not resolve node names via cluster DNS.

```sh
ssh 192.168.2.164 "sudo sed -i '/worker-05/d' /etc/hosts && \
  echo '192.168.2.60   worker-02' | sudo tee -a /etc/hosts"
```

---

### Phase 4: add the OSD (PR 2)

**Task 4.1: confirm the OSD disk is blank**

```sh
sudo wipefs -a /dev/disk/by-id/nvme-<model>_<serial>
sudo sgdisk --zap-all /dev/disk/by-id/nvme-<model>_<serial>
```

A factory SSD usually ships with a Windows install or at least a partition
table. Rook silently skips disks it does not consider clean, and "the OSD never
appeared" is nearly always this.

**Task 4.2: PR 2, add worker-02 to the Ceph cluster**

Modify `clusters/cluster0/kubernetes/apps/rook-ceph/rook-ceph/cluster/helmrelease.yaml`:

```yaml
      storage:
        useAllNodes: false
        useAllDevices: false
        nodes:
          - name: worker-00
            devices:
              - name: /dev/mapper/ubuntu--vg-lvceph
          - name: worker-01
            devices:
              - name: /dev/mapper/ubuntu--vg-lvceph
          # worker-02 has a dedicated OSD disk, so it is a whole-disk OSD
          # addressed by-id. No LVM layer, and the path survives slot changes.
          - name: worker-02
            devices:
              - name: /dev/disk/by-id/nvme-<model>_<serial>
        config:
          osdsPerDevice: "1"
```

Also update `README.md` "Cluster layout": worker list becomes `worker-00`,
`worker-01`, `worker-02`.

```sh
kubectl kustomize clusters/cluster0/kubernetes/apps/rook-ceph
```

Merge to `main`, then:

```sh
flux reconcile kustomization rook-ceph --with-source
kubectl -n rook-ceph get jobs
kubectl -n rook-ceph logs -l app=rook-ceph-osd-prepare --tail=80
kubectl -n rook-ceph get pods -o wide | grep osd
```

**Task 4.3: watch backfill**

```sh
watch -n30 'kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s | grep -E "health|pgs|recovery"'
```

156 GiB of data to replicate onto the new OSD. On the existing 1 GbE fabric
(control-00 and the other workers are 1 GbE even though the K17 is 2.5 GbE)
budget 30 to 90 minutes. Done when `HEALTH_OK` and all 33 PGs `active+clean`.

Note: the OSD liveness probe headroom already in the HelmRelease
(`timeoutSeconds: 30`, `failureThreshold: 6`) was added for worker-05's slow
disk. Leave it. It is harmless on a fast disk and re-adding it after a future
flap costs an outage.

---

### Phase 5: restore workloads

**Task 5.1: confirm replicas rebuilt**

CNPG re-provisions the third instance automatically once a schedulable node with
capacity exists.

```sh
kubectl -n cnpg-system get clusters.postgresql.cnpg.io   # expect 3/3, healthy
kubectl get sts -A                                       # expect full replicas
kubectl -n ai-system get pods -l app.kubernetes.io/name=valkey -o wide
kubectl -n git-system get sts gitea-valkey-cluster       # expect 3/3
```

If a CNPG cluster is still short, delete the missing instance's PVC and let the
operator re-clone:

```sh
kubectl -n cnpg-system delete pvc <cluster>-<n>
```

**Task 5.2: gitea unpinned**

PR 1 removed the `worker-05` nodeSelector. Confirm gitea scheduled somewhere and
is serving:

```sh
kubectl -n git-system get pods -o wide
```

**Task 5.3: sweep for leftovers**

```sh
grep -rn "worker-05" clusters/ README.md AGENTS.md docs/
```

Documentation references in `docs/runbooks/node-reboot.md` and
`docs/postmortems/2026-08-28-node-shutdown-hang.md` are **historical and should
stay**, but the node-reboot runbook's open-items block should be updated: the
"worker-05 has a hardware thermal fault" item is now resolved by replacement.

---

### Phase 6: verification

```sh
kubectl get nodes -o wide                                     # 4 Ready, matching versions
kubectl get pods -A | grep -vE 'Running|Completed'            # empty
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s   # HEALTH_OK, 3 osds up/in
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl get kustomizations -A | grep -v True                  # empty
kubectl get pv | grep -v Bound                                # no orphans
flux get sources all
```

**Task 6.1: prove the shutdown path, once, at the machine**

```sh
kubectl drain worker-02 --ignore-daemonsets --delete-emptydir-data --timeout=10m
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s   # settle first
ssh 192.168.2.60 sudo systemctl reboot
# after it returns
kubectl uncordon worker-02
ssh 192.168.2.60 'journalctl -b -1 -u k3s-agent | tail -40'   # clean stop
ssh 192.168.2.60 'journalctl -b -1 -k | grep -i libceph'      # expect nothing
```

An untested node is a node whose shutdown behaviour you are guessing at. This is
the entire lesson of the 2026-08-28 postmortem.

**Task 6.2: thermal sanity check**

The box it replaces throttled from boot. Establish a baseline:

```sh
ssh 192.168.2.60 'sensors; grep -c . /sys/class/thermal/thermal_zone*/temp'
ssh 192.168.2.60 "awk '{print \$1/1000\"C\"}' /sys/class/thermal/thermal_zone0/temp"
```

Under sustained load, a healthy K17 should sit well below 95 C. If it does not,
drop the BIOS TDP mode from 35W to 25W; the cluster does not need peak clocks.

---

## Files likely to change

| File | Change |
| --- | --- |
| `clusters/cluster0/kubernetes/apps/rook-ceph/rook-ceph/cluster/helmrelease.yaml` | remove worker-05 (PR 1), add worker-02 by-id (PR 2), reword stale osd.2 comments |
| `clusters/cluster0/kubernetes/apps/git-system/gitea/app/helmrelease.yaml:223` | delete the worker-05 `nodeSelector` |
| `README.md` | "Cluster layout" worker list |
| `docs/runbooks/node-reboot.md` | close the worker-05 thermal-fault open item |
| `docs/runbooks/add-cluster-node.md` | new, the reusable procedure |
| `.hermes/plans/2026-09-12_184500-replace-worker05-with-worker02.md` | this plan |

No host configuration lives in Git. The kubelet and logind drop-ins in Task 3.3
are manual on every node, forever, until that changes.

---

## Risks and open questions

**OPEN, needs its own PR: the Cilium `ipv4NativeRoutingCIDR` fix is only applied
live, not in Git.** `clusters/cluster0/kubernetes/apps/kube-system/cilium/app/helmrelease.yaml`
still says `10.244.0.0/16`; it must become `10.42.0.0/16`. Until that merges, any
Flux reconcile of the cilium HelmRelease re-introduces the bug. Applying it
restarts the Cilium agents and briefly disrupts pod networking cluster-wide, so
**do it while Ceph is healthy at 3 hosts, i.e. after Phase 4, not during the
degraded window.**

**OPEN, mitigation in place only: the Flux controllers are pinned to control-00**
via a `FluxInstance` nodeSelector, as a workaround for the CIDR bug. Once the
CIDR fix merges and is verified, remove the pin so the controllers can spread
again. Leaving it pinned indefinitely makes control-00 a single point of failure
for all of GitOps.

**OPEN: jellyfin's transcode cache has no size bound.** `local-path` does not
enforce the PVC's 100Gi request, so the cache can and did fill worker-01's root
disk, evicting the GPU plugin and taking jellyfin down. Fix properly by setting
jellyfin's transcode path to an `emptyDir` with a `sizeLimit`, or enable a
Jellyfin cache-cleanup schedule. **This risk follows jellyfin to whichever node
it lands on, including worker-02.** Until it is fixed, check
`df -h /` on the media node during Phase 6.

**Ceph capacity is bounded by the smallest OSD.** With `failureDomain: host`,
`size: 3`, and three OSD hosts, usable capacity is effectively the smallest OSD.
Today both live OSDs are 775 GiB with 140 GiB used each. If the K17 ships with a
512 GB drive, headroom shrinks from ~635 GiB to roughly ~330 GiB usable. That is
still 2x current usage, so this is a "know it" not a "stop", but if the K17 is
the 1 TB trim, use the whole thing.

**Uneven OSD weights are fine, uneven hosts are not.** Do not try to compensate
by adding a second OSD on one host. With `failureDomain: host` the third replica
needs a third *host*, not a third OSD.

**The cluster runs degraded for the whole job.** From now until Phase 4
completes, one replica of everything on `ceph-block` is missing. A second host
failure during that window means data unavailability. Do not schedule this
alongside other node maintenance, and do not reboot worker-00 or worker-01 while
it is running.

**Lunar Lake on 24.04.** HWE 6.14 should cover Arc 130V (`xe`) and the 2.5 GbE
NIC. If the installer itself cannot see the NIC (the live ISO carries 6.8),
install offline and bring networking up after the HWE kernel, or use a USB
Ethernet dongle for the install. Budget for this; it is the most likely snag.

**Wi-Fi is not a fallback.** Cilium, Ceph, and NFS over Wi-Fi 6E is a bad idea.
If the wired NIC is unsupported, fix the wired NIC.

**worker-05's later return.** It comes back only with a new disk and a new IP
reservation, and it must never be powered on while holding 192.168.2.60. Before
reusing it, confirm its thermal fault is actually fixed; per the postmortem it
was accumulating ~20,717 throttle events and hit 92-95 C. A node that cannot
reboot unattended is not a cluster member, it is a liability.

**Open: does the K17 have an SSD in the box?** Not confirmable from the Micro
Center listing (bot wall). Verify physically.

---

## Contingency A: K17 is barebones, no stock SSD

Then worker-05's drive is the only disk and must carry root **and** the OSD,
exactly like worker-05 did. Partition it as the runbook describes, leave a large
LV unformatted for Ceph, and reference it as `/dev/mapper/ubuntu--vg-lvceph`,
matching worker-00 and worker-01. Accept that OSD and root share a device, which
is the arrangement that made osd.2 the slow one. Buying a cheap NVMe for the
second slot is the better answer.

## Contingency B: worker-05's drive is not 2280, or is M.2 SATA

The K17 has **no SATA support**. An M.2 SATA stick will not enumerate. In that
case the carried drive is dead weight: install on the stock NVMe, and buy a
second NVMe for the OSD.
