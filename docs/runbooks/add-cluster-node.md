# Runbook: adding a worker node to cluster0

Reusable procedure for building a new bare-metal worker, joining it to the k3s
cluster, and giving it a Ceph OSD. Written for the worker-05 to worker-02
replacement (Sept 2026); it is generic enough to reuse for the next box.

Companion documents:
- `docs/runbooks/node-reboot.md` for drain/reboot ordering and the graceful
  shutdown drop-ins (Fix 2). Do not skip those; a node without them repeats the
  2026-08-28 shutdown hang.
- `docs/postmortems/2026-08-28-node-shutdown-hang.md` for why.

Throughout, substitute:

```sh
NODE=worker-02              # new node name (k3s uses the hostname)
NODE_IP=192.168.2.60        # its address on the LAN
CONTROL_IP=192.168.2.32     # control-00's apiserver NIC (see /etc/hosts note)
K3S_VERSION=v1.34.3+k3s1    # must match the rest of the fleet
```

---

## 0. Facts about this cluster you need before you start

| Item | Value |
| --- | --- |
| Distro on every node | Ubuntu Server 24.04 LTS (`24.04.5`) |
| k3s | `v1.34.3+k3s1`, agents run plain `k3s agent`, no extra flags |
| Join token | `/var/lib/rancher/k3s/server/node-token` on control-00 |
| apiserver URL | `https://192.168.2.32:6443` |
| CNI | Cilium (kube-proxy replacement, BGP for LoadBalancer IPs) |
| Storage | Rook Ceph (`ceph-block`), k3s `local-path`, NFS from control-00 |
| Ceph topology | `failureDomain: host`, `replicated size 3`, one OSD per worker |
| Node addressing | DHCP reservation on the router, keyed by NIC MAC |
| SSH | port 22 on the LAN, port 20252 from outside |

Because `failureDomain` is `host` and pool size is 3, **the cluster needs three
OSD hosts to be `HEALTH_OK`**. Removing a worker puts Ceph into
`active+undersized+degraded` until the replacement OSD is in. That is expected,
not an incident, but it is also why you should not start this work with Ceph
already unhealthy for some other reason.

---

## 1. Pre-flight (do not skip)

```sh
kubectl get nodes -o wide
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
kubectl get kustomizations -A | grep -v True
flux get sources all
```

Required state before touching hardware:
- mon quorum is 3/3.
- The only Ceph complaint is the one caused by the node you are replacing.
- No Flux Kustomization is failing for an unrelated reason.

Record which node hosts which mon; mons move, so do not assume.

```sh
kubectl -n rook-ceph get pods -o wide | grep -E 'mon-|osd-'
```

---

## 2. Inventory what is pinned to the outgoing node

Anything that names the old node in Git has to be repointed or unpinned before
the node disappears, or Flux will keep scheduling onto a node that is gone.

```sh
# Git-side pins
grep -rn "kubernetes.io/hostname\|worker-" clusters/ | grep -v '^\s*#'

# Live pins
kubectl get pods -A -o wide --field-selector spec.nodeName=$OLD_NODE

# local-path PVs are node-local and will be orphaned
kubectl get pv -o json | jq -r '
  .items[] | select(.spec.nodeAffinity | tostring | test("'"$OLD_NODE"'"))
  | [.metadata.name, .spec.claimRef.namespace, .spec.claimRef.name] | @tsv'
```

`local-path` volumes do **not** move. Data on them is gone with the disk.
For replicated workloads (CNPG replicas, Valkey cluster members) that is fine;
delete the PVC and let the operator rebuild the member. For anything that is a
sole copy, back it up first or move it to `ceph-block`.

---

## 3. Retire the old node

Drain first so kubelet unmounts RBD and NFS while the network still works.

```sh
kubectl drain $OLD_NODE --ignore-daemonsets --delete-emptydir-data --timeout=10m
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s     # let it settle
```

Take its OSD out of the CRUSH map. `$OSD_ID` comes from `ceph osd tree`.

```sh
T="kubectl -n rook-ceph exec deploy/rook-ceph-tools --"
$T ceph osd out $OSD_ID
$T ceph osd safe-to-destroy osd.$OSD_ID     # wait for "safe to destroy"
$T ceph osd purge $OSD_ID --yes-i-really-mean-it
$T ceph osd crush remove $OLD_NODE          # drop the now-empty host bucket
```

Then remove the node from Git (`storage.nodes` in the rook-ceph-cluster
HelmRelease, plus any `nodeSelector`), merge, and let Flux reconcile. Only then:

```sh
kubectl delete node $OLD_NODE
# Clean up the orphaned local-path PVCs found in step 2
kubectl -n <ns> delete pvc <name>
```

Deleting the node before the PVCs leaves pods stuck `Terminating` forever,
because kubelet is no longer there to confirm the unmount. If that happens:

```sh
kubectl -n <ns> delete pod <pod> --force --grace-period=0
```

Finally, delete the operator-owned rook deployment for the dead OSD if it
lingers:

```sh
kubectl -n rook-ceph delete deploy rook-ceph-osd-$OSD_ID
```

---

## 4. Hardware prep

1. **Match the drive interface.** Confirm what the new chassis accepts before
   moving anything. Modern mini PCs are frequently M.2 NVMe only, with no SATA
   at all, and often have onboard (non-upgradable) LPDDR5X.
2. **Slot order matters.** Where a box has one fast slot (PCIe Gen5 x4) and one
   slower one (Gen4 x2), put the **Ceph OSD disk in the fast slot**. OSD latency
   is what the cluster feels; the root disk mostly holds the OS and `local-path`
   volumes.
3. **Check the OSD candidate's SMART data and its brand before committing it.**
   cluster0 has already been burned here: osd.2's "slow node" was substantially a
   slow *disk*, an unbranded Gen3 part measured at 24ms apply latency against
   4-8ms for the Samsung 980 PRO peers, and it cost a HelmRelease workaround
   (`timeoutSeconds: 30`) plus a 1200-restart flap incident. A budget or QLC
   drive in the OSD slot will reproduce that.

   `smartctl` and `nvme-cli` are **not installed** on these nodes by default, and
   `dmesg` is restricted for non-root users on some of them. Install one:

   ```sh
   sudo apt install -y nvme-cli
   sudo nvme smart-log /dev/nvme0n1 | grep -iE \
     "percentage_used|critical_warning|media_errors|unsafe_shutdowns|power_on_hours"
   ```

   Reject the disk for OSD duty on any nonzero `media_errors`, any
   `critical_warning`, or `percentage_used` above ~80%. Without those tools,
   sysfs still gives model, serial, capacity, link speed, and temperature:

   ```sh
   cat /sys/class/nvme/nvme0/{model,serial,firmware_rev}
   cat /sys/class/nvme/nvme0/device/{current_link_speed,current_link_width}
   for h in /sys/class/hwmon/hwmon*; do echo "$(cat $h/name): $(($(cat $h/temp1_input)/1000))C"; done
   ```

4. **Never trust `nvme0n1` / `nvme1n1` ordering.** Enumeration can flip between
   boots and firmware revisions. Identify disks by serial:

   ```sh
   ls -l /dev/disk/by-id/nvme-*
   lsblk -o NAME,SIZE,MODEL,SERIAL,FSTYPE,MOUNTPOINT
   ```

5. **BIOS settings** to set on a homelab node:
   - Restore on AC power loss: **Power On** (so the node returns after a UPS
     event without a human).
   - Wake-on-LAN enabled if the switch supports it.
   - Secure Boot: either is fine; Ubuntu signs its kernels. Leave it as shipped
     unless you need out-of-tree DKMS modules.
   - Note the NIC MAC address for the DHCP reservation.

---

## 5. Install the OS

**Use Ubuntu Server 24.04 LTS (latest point release), not the newest Ubuntu.**
Every other node in cluster0 runs 24.04; matching the fleet keeps kernel
behaviour, package versions, and the shutdown fixes identical. Desktop images
are not appropriate here.

Download: <https://ubuntu.com/download/server> (the `live-server-amd64` ISO).
Verify it before writing:

```sh
# on macOS
shasum -a 256 ubuntu-24.04.5-live-server-amd64.iso
curl -s https://releases.ubuntu.com/24.04/SHA256SUMS | grep live-server-amd64
```

Write to USB (`/dev/diskN` is the **whole** USB device, unmounted first):

```sh
diskutil list
diskutil unmountDisk /dev/diskN
sudo dd if=ubuntu-24.04.5-live-server-amd64.iso of=/dev/rdiskN bs=4m status=progress
diskutil eject /dev/diskN
```

Installer choices:

| Prompt | Answer |
| --- | --- |
| Installation type | Ubuntu Server (**not** minimized; you want tooling) |
| Hostname | the node name exactly, e.g. `worker-02` (k3s derives the node name from it) |
| Network | leave DHCP; pin the address by MAC reservation on the router |
| Storage | **Custom storage layout** on the intended root disk only |
| Other disks | leave completely untouched; Ceph wants them raw |
| Third-party drivers | yes |
| OpenSSH server | **install it**, import your GitHub keys if you use that |
| Snaps | none |

Root disk layout (mirrors worker-00/worker-01):

- 1 GB EFI system partition, `/boot/efi`
- 2 GB ext4, `/boot`
- remainder as an LVM PV in VG `ubuntu-vg`, with root LV `ubuntu-lv` ext4 on `/`

If the root disk is large, still leave the OSD on a separate physical disk.
Mixing root and OSD on one device is what made the old node's OSD the slow one.

After first boot:

```sh
sudo apt update && sudo apt full-upgrade -y

# HWE kernel: required for recent Intel platforms (Lunar Lake / Arc iGPU / NPU,
# newer 2.5GbE controllers). The 24.04 GA kernel is 6.8 and does not know them.
sudo apt install -y linux-generic-hwe-24.04 linux-firmware

# Packages the cluster's storage stack needs on every node
sudo apt install -y nfs-common open-iscsi lvm2

sudo systemctl enable --now iscsid
sudo reboot
```

Verify after reboot:

```sh
uname -r                      # expect 6.14.x from HWE, not 6.8.x
ip -br a                      # NIC up, expected address
ls /dev/dri                   # renderD128 present if the iGPU is supported
lsblk -o NAME,SIZE,MODEL,SERIAL,FSTYPE,MOUNTPOINT
```

If `/dev/dri/renderD128` is missing, the GPU device plugin will simply not
advertise `gpu.intel.com/i915` on this node. That is only a problem if you
intend to schedule transcoding here.

---

## 6. Apply the host fixes that are not in Git

There is no host-level config management in this repo. These are manual and
**must** be done on every node, including new ones.

### 6a. kubelet graceful node shutdown

k3s ships `00-k3s-defaults.conf` that sets both grace periods to `0s`, actively
disabling graceful shutdown. The `10-` prefix makes our file sort after it.
The directory only exists once k3s has run, so do this **after** section 7 and
then restart the agent, or create the directory by hand now.

`/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf`

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
shutdownGracePeriod: 180s
shutdownGracePeriodCriticalPods: 60s
```

### 6b. logind inhibitor delay

`InhibitDelayMaxSec` must be **>= `shutdownGracePeriod`** or the shorter value
silently truncates the eviction. Ubuntu's `unattended-upgrades` ships a vendor
drop-in setting 30s; override it by **reusing its exact filename** under `/etc`
(drop-ins sort by filename across all directories, last wins):

`/etc/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf`

```ini
[Login]
InhibitDelayMaxSec=180
```

```sh
sudo systemctl restart systemd-logind
```

### 6c. Verify both

```sh
# expect: t 180000000
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 \
  org.freedesktop.login1.Manager InhibitDelayMaxUSec

# expect a delay lock held by kubelet (after k3s is running)
systemd-inhibit --list | grep -i kubelet
```

> Re-check 6a after any k3s upgrade. k3s owns that directory and may reset it.

---

## 7. Join the node to k3s

Get the token from control-00:

```sh
ssh 192.168.2.164 'sudo cat /var/lib/rancher/k3s/server/node-token'
```

On the new node, **pin the version to the fleet's version**. The install script
otherwise fetches the current stable channel, which can land you on an agent
newer than the server; that is unsupported and skew will bite silently.

```sh
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION=v1.34.3+k3s1 \
  K3S_URL=https://192.168.2.32:6443 \
  K3S_TOKEN='<token>' \
  sh -
```

Then apply 6a (the kubelet drop-in directory now exists) and restart:

```sh
sudo systemctl restart k3s-agent
systemctl status k3s-agent --no-pager
```

Verify from your workstation:

```sh
kubectl get nodes -o wide
kubectl get pods -A -o wide --field-selector spec.nodeName=$NODE
```

Expect the DaemonSets to land on their own: `cilium`, `cilium-envoy`,
`node-feature-discovery` worker, `intel-gpu-plugin`, the Rook discover pod, and
the metrics/logs collectors. Nothing needs to be applied by hand.

```sh
# NFD should populate feature labels within a minute or two
kubectl get node $NODE --show-labels | tr ',' '\n' | grep feature.node

# GPU capacity, if this box has a supported Intel iGPU
kubectl get node $NODE -o jsonpath='{.status.capacity}' | jq
```

---

## 8. Add the Ceph OSD

Identify the OSD disk **by id**, on the node:

```sh
ls -l /dev/disk/by-id/nvme-* | grep -v part
```

Make sure it is truly blank. Rook refuses disks with an existing filesystem or
partition table, and silently skipping is the usual reason "the OSD never
appeared".

```sh
sudo wipefs -a /dev/disk/by-id/nvme-<model>_<serial>
sudo sgdisk --zap-all /dev/disk/by-id/nvme-<model>_<serial>
sudo blkdiscard /dev/disk/by-id/nvme-<model>_<serial>   # optional, SSD only
```

Then add the node in Git, in
`clusters/cluster0/kubernetes/apps/rook-ceph/rook-ceph/cluster/helmrelease.yaml`
under `cephClusterSpec.storage.nodes`:

```yaml
        nodes:
          - name: worker-00
            devices:
              - name: /dev/mapper/ubuntu--vg-lvceph
          - name: worker-01
            devices:
              - name: /dev/mapper/ubuntu--vg-lvceph
          - name: worker-02
            devices:
              - name: /dev/disk/by-id/nvme-<model>_<serial>
```

Whole-disk by-id is preferred for a dedicated OSD disk: no LVM layer to manage,
and the path is stable across reboots and slot changes. LVM paths on the other
two nodes are historical, because their OSD shares a disk with root.

Open a PR, merge to `main`, then:

```sh
flux reconcile kustomization rook-ceph --with-source
kubectl -n rook-ceph get jobs -w                 # a prepare job appears
kubectl -n rook-ceph logs -l app=rook-ceph-osd-prepare --tail=50
kubectl -n rook-ceph get pods -o wide | grep osd
```

Watch it backfill. On a ~775 GB OSD holding roughly 140 GB this takes tens of
minutes on 1 GbE:

```sh
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
watch -n30 'kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s | grep -E "pgs|health"'
```

Done when `ceph -s` reports `HEALTH_OK` and all PGs `active+clean`.

---

## 9. Restore pinned workloads

Repoint anything that named the old node, in Git:

```sh
grep -rn "<old-node>" clusters/
```

Prefer deleting the pin over repointing it. Pin only for a real reason (local
disk, a specific iGPU, physical proximity to the NAS), and write the reason in a
comment next to it.

Re-create the PVCs deleted in step 3 by letting their operators do it:
CNPG re-provisions a replica when you delete the instance's PVC and pod; Valkey
cluster members resync on restart.

```sh
kubectl -n cnpg-system get clusters.postgresql.cnpg.io    # expect 3/3 ready
kubectl get sts -A                                        # expect full replicas
```

---

## 10. Final verification checklist

```sh
kubectl get nodes -o wide                                  # all Ready, right versions
kubectl get pods -A | grep -vE 'Running|Completed'         # empty
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s # HEALTH_OK, 3 osds up/in
kubectl get kustomizations -A | grep -v True               # empty
kubectl get pv | grep -v Bound                             # no orphans
```

Then prove the shutdown path actually works, once, while you are next to the
box:

```sh
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data --timeout=10m
ssh $NODE_IP sudo systemctl reboot
# after it returns:
kubectl uncordon $NODE
journalctl -b -1 -u k3s-agent | tail -40      # clean stop, no libceph errors
```

A node that has never been rebooted under test is a node you do not know the
shutdown behaviour of.

---

## 11. Housekeeping

- **DHCP reservation:** point the reservation at the new NIC MAC. If you reused
  the old node's address, the old box will collide if it is ever powered on
  again on the same LAN; give it a fresh reservation before returning it.
- **control-00 `/etc/hosts`:** it does not use cluster DNS for node names. Add
  the new node or `ssh worker-xx` will fail from there:

  ```sh
  echo '192.168.2.60   worker-02' | sudo tee -a /etc/hosts
  ```

  Prefer IPs in automation regardless.
- **README:** update the "Cluster layout" worker list.
- **UPS / NUT:** if the fleet gains an ordered-shutdown client config, the new
  node needs it too. As of this writing `nut-monitor` is inactive on workers.
- **Renovate / Flux:** nothing node-specific. No registration step exists.

---

## Known traps

| Symptom | Cause | Fix |
| --- | --- | --- |
| Node joins as the wrong name | hostname not set before install | `hostnamectl set-hostname`, uninstall and rejoin the agent |
| Agent newer than server | `INSTALL_K3S_VERSION` omitted | reinstall pinned to the fleet version |
| OSD never appears | disk not blank, or wrong device path | `wipefs`/`sgdisk --zap-all`, check prepare job logs |
| OSD appears then flaps | slow disk vs. 5s liveness probe | already mitigated in the HelmRelease (`timeoutSeconds: 30`) |
| Pods stuck `Terminating` forever | node deleted before its PVCs | `--force --grace-period=0`, then delete the PVCs |
| Ceph stuck undersized after join | pool size 3, `failureDomain: host` | you need three OSD *hosts*; a second OSD on one host will not satisfy it |
| Shutdown hangs in `systemd-shutdown` | section 6 skipped | apply 6a and 6b, verify with `busctl` |
| `/dev/dri` missing | GA kernel too old for the iGPU | install `linux-generic-hwe-24.04` |
| `card0` present but `renderD128` missing | same, partial support: the driver binds but exposes no render node, so there is no hardware transcoding | install the HWE kernel and reboot; verify with `ls /dev/dri` |
| GPU workloads will not schedule on a new node although the plugin is `Running` and the node is labelled | **the advertised resource name follows the kernel driver.** Newer Intel iGPUs (Lunar Lake and later) use `xe` and advertise `gpu.intel.com/xe`; older ones use `i915` and advertise `gpu.intel.com/i915`. A pod requesting one will never schedule on a node offering the other. | check with the command below, then reconcile the resource name across the fleet before assuming the GPU is broken |
| GPU workload unschedulable, node shows `i915: 0` | node hit `DiskPressure` and evicted the `intel-gpu-plugin` DaemonSet pod | free disk space, wait ~5 min for the condition to clear, then **delete the evicted pod by hand** (the DaemonSet will not replace it on its own) |
| Node disk fills unexpectedly | a `local-path` PVC exceeded its request; **local-path does not enforce capacity** | find it with the kubelet stats API (below); cap the workload with an `emptyDir` `sizeLimit` or a cleanup schedule |
| `sudo` over SSH hangs | node requires a sudo password, no TTY | use a privileged debug pod instead of SSH (below) |

### Finding what filled a node's disk

`du -x /` on a full node takes minutes and often times out; `sudo` over SSH may
prompt for a password. The kubelet stats API needs neither:

```sh
kubectl get --raw "/api/v1/nodes/<node>/proxy/stats/summary" | \
  jq '.pods[] | {p:"\(.podRef.namespace)/\(.podRef.name)",
                 eph:.["ephemeral-storage"].usedBytes,
                 vol:([.volume[]?.usedBytes]|add)}'
```

Beware: that only reports space kubelet attributes to pods. A `local-path`
PVC's contents may not show up there, and node usage can far exceed the sum of
the pods. When the numbers do not add up, inspect the host directly with a
privileged pod (`system-node-critical`, so `DiskPressure` admission does not
reject it):

```sh
kubectl run disk-inspect -n kube-system --image=busybox:1.36 --restart=Never \
  --overrides='{"spec":{"nodeName":"<node>","priorityClassName":"system-node-critical",
    "tolerations":[{"operator":"Exists"}],
    "containers":[{"name":"shell","image":"busybox:1.36","command":["sleep","600"],
      "securityContext":{"privileged":true},
      "volumeMounts":[{"name":"host","mountPath":"/host"}]}],
    "volumes":[{"name":"host","hostPath":{"path":"/"}}]}}' -- sleep 600

kubectl -n kube-system exec disk-inspect -- du -xh -d1 /host/var/lib/rancher/k3s/storage | sort -rh | head
kubectl -n kube-system delete pod disk-inspect
```

`/var/lib/rancher/k3s/storage` is where `local-path` PVCs live, and is the first
place to look.

### Checking which GPU resource each node advertises

Do this right after the join, before concluding a GPU workload is broken:

```sh
for n in $(kubectl get nodes -o name | cut -d/ -f2); do
  echo "$n: $(kubectl get node $n -o jsonpath='{.status.allocatable}' \
    | tr ',' '\n' | grep -i 'gpu.intel.com')"
done
```

A mixed fleet is normal once you add a newer box, and it is a scheduling
problem, not a hardware fault:

```
worker-00: "gpu.intel.com/i915":"4"     # Coffee Lake, i915 driver
worker-02: "gpu.intel.com/xe":"4"       # Lunar Lake,  xe driver
```

Confirm the driver behind it with
`basename $(readlink -f /sys/class/drm/card0/device/driver)` on the node. Decide
deliberately whether to pin GPU workloads to one node class or to normalise the
resource name across the fleet; do not leave the mismatch undocumented, because
the symptom (`Pending`, "didn't match Pod's node affinity/selector") looks
nothing like the cause.
