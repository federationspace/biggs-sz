# Runbook: upgrading cluster0 k3s from v1.34.3+k3s1 to v1.36.6+k3s1

Procedure for the rolling in-place upgrade of `cluster0` from `v1.34.3+k3s1` to
`v1.36.6+k3s1` (control plane first, then agent nodes one at a time, `ai-00`
last).

Companion documents (read before starting):
- `docs/runbooks/node-reboot.md` for Ceph quorum gates, kubelet graceful node
  shutdown drop-ins (Fix 2), loopback NFS behavior on `control-00` (Fix 3), and
  `NodeShutdown` tombstone cleanup.
- `docs/runbooks/add-cluster-node.md` for the `get.k3s.io` install environment,
  join token path, apiserver address, and `ai-00` GPU node host configuration.
- `docs/postmortems/2026-08-28-node-shutdown-hang.md` for why graceful-shutdown
  drop-ins and SQLite online backups matter on this cluster.
- Vendor references: <https://docs.k3s.io/upgrades/manual>,
  <https://docs.k3s.io/upgrades/roll-back>,
  <https://docs.k3s.io/datastore/backup-restore>, and
  <https://docs.k3s.io/release-notes/v1.36.X>.

## Labor split and command conventions

- **Human operator (laptop, `fish` shell)**: runs every node-side SSH command
  and every mutating `kubectl` command (`cordon`, `drain`, `uncordon`,
  `get.k3s.io` upgrade, `systemctl reboot`, drop-in re-check/re-apply, and
  `Failed`-pod cleanup). All laptop snippets below are `fish`-compatible.
- **Hermes agent (`hermes` pod, read-only ServiceAccount)**: runs every
  read-only `kubectl` pre-flight check, drain verification, Ceph/CNPG/Flux exit
  gate, and final verification, handing over the exact next command at each
  gate. During Window 5 (`ai-00`), `Radiance` is offline so the user drives that
  window end-to-end and prompts the agent once `ai-00` and `Radiance` are back.
- **One node at a time**: never cordon or reboot a second node until the
  previous node is `Ready`, uncordoned, and Ceph is back to `3/3` mon quorum
  with all `33 active+clean` PGs.
- **SSH addressing**: always SSH by **LAN IP**, not hostname (`control-00`'s
  `/etc/hosts` omits `worker-02` and `ai-00`). On the LAN or over the UDM
  WireGuard VPN, connect directly to `szkud@<NODE_IP>` (port 22). Off-VPN, open
  one `ControlMaster` to `control-00` (`ssh -M -S /tmp/cm-c00 -o ControlPersist=30m -p 20252 szkud@69.61.172.135`)
  and reach other nodes with `-o ProxyCommand='ssh -S /tmp/cm-c00 -p 20252 szkud@69.61.172.135 -W %h:%p'`.
  Use interactive SSH (`ssh szkud@<NODE_IP>` or `ssh -t`) whenever `sudo`
  prompts for a password.

---

## 0. Fleet facts and pre-existing baseline

### Cluster facts

| Item | Value |
| --- | --- |
| Distro on every node | Ubuntu Server 24.04.5 LTS |
| Current -> target k3s | `v1.34.3+k3s1` -> `v1.36.6+k3s1` (Kubernetes `v1.36.6`, containerd `v2.3.7-k3s1.36`) |
| `control-00` server flags | `server --flannel-backend=none --disable-kube-proxy --disable=servicelb --disable-network-policy --disable=traefik` |
| Agent join config | `K3S_URL=https://192.168.2.32:6443`, token at `/var/lib/rancher/k3s/server/node-token` on `control-00`, plain `k3s agent` |
| `ai-00` host config | `/etc/rancher/k3s/config.yaml` sets `node-label: biggs.sz/role=ai` and `node-taint: amd.com/gpu=present:NoSchedule` |
| Control-plane datastore | Single-server embedded SQLite/kine at `/var/lib/rancher/k3s/server/db/state.db` + `/var/lib/rancher/k3s/server/token` (not embedded etcd) |
| CNI and LoadBalancer VIPs | Cilium (kube-proxy replacement + BGP pool `192.168.2.6-254`: `.7` k8s-gateway, `.8` lan-dns, `.9` wildcard-gregbob-net, `.10` livekit, `.11` dreamcast) |
| Ceph topology | `failureDomain: host`, `replicated size 3`, 3 OSDs device-pinned to `/dev/mapper/ubuntu--vg-lvceph` on `worker-00/01/02` (no 4th Ceph host) |
| CNPG topology | 8 cluster objects in `cnpg-system` (7 healthy; 3 replicas each on `local-path` PVCs, `enablePDB: true`, drain-aware automatic failover + replica rebuild; `cnpg-pinepods` decommissioned by commit `862890e`; `cnpg-kritika` broken) |
| House drain flags | `kubectl drain <NODE> --ignore-daemonsets --delete-emptydir-data --timeout=10m` |
| Graceful-shutdown files | `/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf` (180s/60s) + `/etc/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf` (`InhibitDelayMaxSec=180`) |

### Fleet execution order (verified 2026-11-25)

| Order | Node | LAN IP | k3s role | Ceph daemons (as of recon) | Notable workloads and window impact | Reboot dark gap |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `control-00` | `192.168.2.164` (apiserver/NFS `192.168.2.32`) | `server` | none (Rook operator, `mgr.a`, CSI controllers reschedule) | API server + Flux down during reboot; ZFS/NFS server pauses worker `hard` NFS mounts; `hermes` (`ceph-block`) + `pocket-id` + `oauth2-proxy` + `agentgateway` move to workers; pinned `*arr`/media, `gitea`, `grafana`, `vmsingle`, `renovate`, `gitea-valkey-cluster-0` down for window | ~169s (includes 120s netplan wait on unplugged `enp1s0f0`) |
| 2 | `worker-00` | `192.168.2.204` | `agent` | `osd.0`, `mon-f` | Ceph `2/3` quorum + `active+undersized+degraded`; `romm`, `lan-dns` (1/2), 6 CNPG replicas move/rebuild; pinned `silo` (`i915`) + `gitea-valkey-cluster-2` (`local-path`) wait for uncordon | ~20s (+ inhibitor delay) |
| 3 | `worker-01` | `192.168.2.117` | `agent` | `osd.1`, `mon-d` (leader) | Ceph `2/3` quorum (mon leader re-elects) + `active+undersized+degraded`; `continuwuity-0` (`local-path`) + `plex` (`i915`, pre-existing failure) stay down until uncordon; `livekit` + `coturn` down (UDM forwards stay on `.117`); `cnpg-silo-2` rebuilds | ~20s (+ inhibitor delay) |
| 4 | `worker-02` | `192.168.2.60` | `agent` | `osd.2`, `mon-g` | Ceph `2/3` quorum + `active+undersized+degraded`; public ingress `wildcard-gregbob-net` (VIP `.9`) unpinned and reschedules (verify VIP `.9`); pinned `jellyfin` (`xe`) waits for uncordon; 3 CNPG replicas + `gitea-valkey-cluster-1` + `kritika` (1/2) move | ~20s (+ inhibitor delay) |
| 5 | `ai-00` (**LAST**) | `192.168.2.90` | `agent` (GPU) | none | **Hermes LLM (`Radiance`) offline for window**; `radiance-models` (`local-path`) stays on `ai-00`; `dreamcast` (VIP `.11`) down; GPU taint/label in `/etc/rancher/k3s/config.yaml` survive | ~20s (+ inhibitor delay) |

### Known pre-existing anomalies (2026-11-25: do NOT fix, do NOT block on)

Record what is already non-green at pre-flight and gate each window on **zero
new regressions** against that baseline:
- `media/plex` on `worker-01`: `Pending` / `ImagePullBackOff` (`0/1`).
- `cnpg-system/cnpg-kritika`: cluster object recreated 2026-11-25T18:57Z (`Setting up primary`);
  `cnpg-kritika-1-initdb-*` jobs fail to `Error` repeatedly (recon placement: `worker-00`;
  failed `Error` pods are terminal and do not block drain). While `cnpg-kritika` remains
  broken, `kritika` pods sit at `0/1 Running` (recon: one each on `control-00`, `worker-00`,
  `worker-02`; deployment 0/2), `pdb/kritika` reports
  `ALLOWED DISRUPTIONS: 0`, and Flux Kustomization `cnpg-databases` plus its
  `dependsOn` chain (`kritika`, `pocket-id`, `gitea`, `act-runner`,
  `oauth2-proxy`, `listenarr`, `open-webui`, `radiance-dashboard`, `pinepods`,
  `renovate`, `romm`, `rreading-glasses`, `silo`) report `dependency ... is not ready`.
- `media/silo`: stale `UnexpectedAdmissionError` pod record alongside the
  healthy `1/1 Running` `silo` pod on `worker-00` (clears with `Failed`-pod
  cleanup).
- `cnpg-pinepods`: decommissioned from the repo and cluster by commit `862890e`
  (2026-11-25); Flux may still be reconciling the deletion; terminating
  `cnpg-pinepods` objects are not a regression.

---

## 1. Fleet-wide pre-flight (do not skip)

### 1.1 Agent read-only cluster checks

Run from the `hermes` pod (or laptop) and capture the pre-upgrade baseline:

```sh
# All 5 nodes must be Ready at v1.34.3+k3s1
kubectl get nodes -o wide

# Verify live Ceph mon and OSD placement (mons move; never assume from tables)
kubectl -n rook-ceph get pods -o wide | grep -E 'mon-|osd-'

# Required gate: mon quorum 3/3, 3 osds up and in, all 33 PGs active+clean
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree

# CNPG baseline: all 7 active clusters must be 3/3 'Cluster in healthy state'
# (ignore pre-existing cnpg-kritika; cnpg-pinepods decommissioned at 862890e)
kubectl -n cnpg-system get clusters.postgresql.cnpg.io

# Flux baseline: check sources and Kustomizations (no unrelated failures)
flux get sources all
kubectl get kustomizations -A | grep -v True

# Pod and PDB baseline
kubectl get pods -A | grep -vE 'Running|Completed'
kubectl get pdb -A
```

Stop if: any node is `NotReady`, Ceph mon quorum is not `3/3`, any OSD is down,
any PG is not `active+clean`, any of the 7 healthy CNPG clusters is degraded, or
a Flux source/Kustomization is failing outside the known `cnpg-kritika` chain.

### 1.2 User host-side pre-flight: graceful-shutdown drop-ins on all 5 nodes

Run from the laptop (`fish` shell) to verify both Fix 2 drop-ins, the `180s`
logind inhibitor ceiling, and the active `kubelet` delay lock on every node
before starting:

```fish
for ip in 192.168.2.164 192.168.2.204 192.168.2.117 192.168.2.60 192.168.2.90
  echo "=== $ip ==="
  ssh szkud@$ip 'hostname; test -f /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf && echo kubelet-dropin=present || echo kubelet-dropin=MISSING; test -f /etc/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf && echo logind-dropin=present || echo logind-dropin=MISSING; busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager InhibitDelayMaxUSec; systemd-inhibit --list | grep -i kubelet || echo kubelet-lock=MISSING'
end
```

Expected on **all five** nodes before proceeding:
- `kubelet-dropin=present`
- `logind-dropin=present`
- `t 180000000` (not `t 30000000` or `t 5000000`)
- A `kubelet` `shutdown` `delay` inhibitor line (never `kubelet-lock=MISSING`)

If any node is missing either drop-in, apply Fix 2 from
`docs/runbooks/node-reboot.md` first before starting the upgrade.

### 1.3 User host-side pre-flight: control-plane datastore backup and join token

Before touching `control-00`, SSH interactively to `control-00`
(`ssh szkud@192.168.2.164`):

1. Check datastore mode and take a verified pre-upgrade backup:
   `cluster0` runs k3s's single-server SQLite/kine datastore
   (`/var/lib/rancher/k3s/server/db/state.db`), so `k3s etcd-snapshot ls`
   reports `etcd datastore disabled`. Check `etcd-snapshot ls` first (in case
   embedded etcd is enabled in the future), then take an online SQLite backup
   via Python's `sqlite3` backup API (never raw `cp` across an active WAL) plus
   a copy of `/var/lib/rancher/k3s/server/token`:

   ```sh
   # On control-00 (192.168.2.164):
   sudo k3s etcd-snapshot ls || true

   sudo mkdir -p /var/backups/k3s-pre-1.36.6
   sudo chmod 700 /var/backups/k3s-pre-1.36.6
   sudo python3 -c "import sqlite3; src=sqlite3.connect('/var/lib/rancher/k3s/server/db/state.db'); dst=sqlite3.connect('/var/backups/k3s-pre-1.36.6/state-v1.34.3.db'); src.backup(dst); ok=dst.execute('PRAGMA quick_check').fetchall(); dst.close(); src.close(); print('quick_check:', ok)"
   sudo cp -a /var/lib/rancher/k3s/server/token /var/backups/k3s-pre-1.36.6/token-v1.34.3
   sudo ls -lh /var/backups/k3s-pre-1.36.6/
   ```

   Expected: `quick_check: [('ok',)]` and both `state-v1.34.3.db` (hundreds of
   MiB) and `token-v1.34.3` present with recent timestamps. (If embedded etcd is
   ever enabled later, verify a fresh snapshot under
   `/var/lib/rancher/k3s/server/db/snapshots/` and run
   `sudo k3s etcd-snapshot save --name pre-v1.36.6`.)

2. Read the agent join token for Windows 2-5 (do not paste or echo the token
   into chat):

   ```sh
   # On control-00, view when needed for agent upgrades:
   sudo cat /var/lib/rancher/k3s/server/node-token
   ```

   Or store it in a local `fish` variable on the laptop without echoing it:

   ```fish
   read -s -P "Paste K3S_TOKEN from control-00: " K3S_TOKEN
   string length "$K3S_TOKEN"
   ```

---

## 2. Standard per-node upgrade window (checklist)

Every node window follows this exact 10-step loop; Section 3 gives the concrete
commands and caveats for each of the five nodes:

1. **Ceph entry gate (agent)**: confirm `mon` quorum `3/3`, `3 osds: 3 up, 3 in`,
   and all `33 active+clean` PGs (`kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s`).
2. **Cordon (user, laptop)**: `kubectl cordon <NODE>`.
3. **Drain with house flags (user, laptop)**:
   `kubectl drain <NODE> --ignore-daemonsets --delete-emptydir-data --timeout=10m`.
   - *Note on `kritika` PDB*: if `cnpg-kritika` is still unrecovered, `pdb/kritika`
     has `ALLOWED DISRUPTIONS: 0` (deployment 0/2) under Kubernetes's default
     policy and rejects evicting any `kritika` `0/1 Running` pod on the cordoned
     node (recon placement: `control-00`, `worker-00`, `worker-02`). With the node already cordoned, delete only
     that pod (`kubectl -n kritika delete pod <kritika-pod-on-node>`) so it
     recreates elsewhere and let `kubectl drain` finish. **Never** pass
     `--disable-eviction` (that bypasses CNPG and Rook-Ceph PDBs).
4. **Verify drain (agent)**:
   `kubectl get pods -A -o wide --field-selector spec.nodeName=<NODE>` must show
   only DaemonSet pods in `Running` phase on `<NODE>` (plus any `Completed`/`Error`
   job pods).
5. **Upgrade k3s in place (user, on node via interactive SSH)**: re-run
   `https://get.k3s.io` with `INSTALL_K3S_VERSION=v1.36.6+k3s1` (server form on
   `control-00`; agent join form from `add-cluster-node.md` on `worker-00`,
   `worker-01`, `worker-02`, and `ai-00`). Confirm `k3s --version` prints
   `v1.36.6+k3s1`.
6. **Reboot node (user, on node)**: `sudo systemctl reboot` (optional: run
   `sudo systemctl stop unattended-upgrades` right before `reboot` to skip the
   180s `unattended-upgrades` inhibitor delay documented in `node-reboot.md`).
7. **Node `Ready` at `v1.36.6+k3s1` (agent; user on `ai-00`)**: wait for
   `kubectl get node <NODE> -o wide` to report `Ready,SchedulingDisabled` and
   `VERSION` `v1.36.6+k3s1`.
8. **Re-check graceful-shutdown drop-in BEFORE uncordoning (user, on node)**:
   confirm `/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf`
   still exists and `systemd-inhibit --list | grep -i kubelet` shows the active
   delay lock. If the upgrade wiped `10-graceful-shutdown.conf`, re-create it
   and restart `k3s` (server) or `k3s-agent` (agents) before uncordoning:

   ```sh
   sudo mkdir -p /var/lib/rancher/k3s/agent/etc/kubelet.conf.d
   printf '%s\n' \
     'apiVersion: kubelet.config.k8s.io/v1beta1' \
     'kind: KubeletConfiguration' \
     'shutdownGracePeriod: 180s' \
     'shutdownGracePeriodCriticalPods: 60s' \
     | sudo tee /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf >/dev/null
   # Restart k3s (on control-00) OR k3s-agent (on workers / ai-00):
   sudo systemctl restart k3s         # control-00 only
   sudo systemctl restart k3s-agent   # worker-00, worker-01, worker-02, ai-00
   systemd-inhibit --list | grep -i kubelet
   ```

9. **Uncordon (user, laptop)**: `kubectl uncordon <NODE>`.
10. **Exit gate and tombstone cleanup (agent + user)**:
    - Agent verifies Ceph `3/3` quorum + `33 active+clean` PGs, all 7 healthy
      CNPG clusters `3/3 Cluster in healthy state`, Flux Kustomizations `Ready`
      (matching pre-flight baseline), `cilium` DaemonSet `5/5`, `cilium-operator`
      `2/2`, and no new `Pending` or crash-looping pods.
    - User inspects and clears `Failed` `NodeShutdown` pod tombstones left by
      the shutdown window:

      ```fish
      kubectl get pods -A --field-selector status.phase=Failed -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,REASON:.status.reason
      kubectl delete pods -A --field-selector spec.nodeName=<NODE>,status.phase=Failed
      ```

---

## 3. Per-node execution windows

### 3.1 Window 1: `control-00` (`192.168.2.164`, k3s server, FIRST)

**Special notes for `control-00`:**
- **Complete Section 1.3 datastore backup check first.** Do not upgrade the
  server without a verified `state-v1.34.3.db` + `token-v1.34.3` backup.
- **API server and Flux outage**: the Kubernetes API (`192.168.2.32:6443`) and
  Flux reconciliation are **down** while `k3s.service` restarts and throughout
  the reboot dark gap (~169s total, dominated by the 120s
  `systemd-networkd-wait-online` timeout on unplugged `enp1s0f0`).
- **Hermes agent pod survives**: `hermes/hermes` mounts `hermes-data` on
  `ceph-block`, so draining `control-00` reschedules `hermes` onto a worker
  before the server stops (expect a brief chat reconnect blip during the move,
  and `kubectl` inside the pod errors temporarily while the API server reboots).
- **NFS clients freeze briefly**: `control-00` is the ZFS/NFS server
  (`192.168.2.32`); worker media pods mounting `media-pvc` `hard` (`jellyfin`,
  `plex`, `silo`, `romm`) block on NFS I/O during the reboot and recover
  automatically once `nfs-server` returns.
- **Ingress vs auth/apps**: public ingress data plane (`wildcard-gregbob-net`,
  VIP `192.168.2.9`) runs on `worker-02` and stays up; unpinned single-replica
  pods on `control-00` (`pocket-id`, `oauth2-proxy`, `oauth2-proxy-valkey`,
  `agentgateway` controller, `coredns`, `metrics-server`, `volsync`) reschedule
  to workers on drain; `lan-dns` (1 of 2) and 11 CNPG replicas (recon 2026-11-25) fail over/rebuild
  on workers; pinned workloads (`*arr` media apps, `sabnzbd`, `gitea`,
  `act-runner`, `grafana`, `vmsingle`/`victoria-logs`, `renovate`) and
  `gitea-valkey-cluster-0` (`local-path`) stay down until `control-00` is
  uncordoned.
- **Preserve Cilium server flags**: `control-00` runs with
  `--flannel-backend=none --disable-kube-proxy --disable=servicelb --disable-network-policy --disable=traefik`.
  Per `docs.k3s.io/upgrades/manual`, re-running `get.k3s.io` overwrites
  `/etc/systemd/system/k3s.service` with only the arguments passed on that run.
  Check `/etc/systemd/system/k3s.service` and `/etc/rancher/k3s/config.yaml`
  first and pass the flags as shown below.

**Commands:**

```fish
# 1. Agent confirms Ceph entry gate (quorum 3/3, 33 active+clean)
# 2-3. User cordons and drains from laptop (fish):
kubectl cordon control-00
kubectl drain control-00 --ignore-daemonsets --delete-emptydir-data --timeout=10m
# If kritika-*-* (0/1 Running) blocks drain under pdb/kritika:
#   kubectl -n kritika get pods -o wide --field-selector spec.nodeName=control-00
#   kubectl -n kritika delete pod <kritika-pod-on-control-00>
#   kubectl drain control-00 --ignore-daemonsets --delete-emptydir-data --timeout=10m
```

After the agent confirms only DaemonSet pods remain Running on `control-00`, run
on `control-00` (`ssh szkud@192.168.2.164`):

```sh
# Inspect current unit vs config.yaml so server flags are preserved exactly
sudo grep -A8 '^ExecStart=' /etc/systemd/system/k3s.service
sudo cat /etc/rancher/k3s/config.yaml 2>/dev/null || echo "no config.yaml"

# Standard case (flags live in k3s.service ExecStart, no config.yaml):
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION=v1.36.6+k3s1 \
  sh -s - server \
    --flannel-backend=none \
    --disable-kube-proxy \
    --disable=servicelb \
    --disable-network-policy \
    --disable=traefik
# (If /etc/rancher/k3s/config.yaml already holds those 5 keys and ExecStart is
# bare 'server', omit the 5 trailing --flags so they are not duplicated.)

k3s --version    # expect: k3s version v1.36.6+k3s1

sudo systemctl stop unattended-upgrades
sudo systemctl reboot
```

Once `control-00` returns (~3 minutes including the netplan wait) and `kubectl get node control-00 -o wide`
shows `Ready,SchedulingDisabled` at `v1.36.6+k3s1`:

```sh
# On control-00: re-check graceful-shutdown drop-in, inhibitor lock, and clean prior shutdown
test -f /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf && echo kubelet-dropin=ok || echo kubelet-dropin=MISSING
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager InhibitDelayMaxUSec
systemd-inhibit --list | grep -i kubelet
sudo journalctl -b -1 -o short-precise | tail -20
ps -eo stat,pid,comm | awk '$1 ~ /^D/'
```

If `kubelet-dropin=MISSING`, re-apply per Section 2 Step 8 and `sudo systemctl restart k3s`.
Verify from the agent (or laptop) that server flags survived
(`kubectl get node control-00 -o jsonpath='{.metadata.annotations.k3s\.io/node-args}'; echo`
and no `traefik` or `svclb-*` pods exist in `kube-system`), then uncordon and
clean up from the laptop (`fish`):

```fish
kubectl uncordon control-00
# Wait for agent exit gate (Ceph 33 active+clean, 7 CNPG clusters 3/3, gitea + pinned apps Running, Flux baseline):
kubectl get pods -A --field-selector status.phase=Failed -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,REASON:.status.reason
kubectl delete pods -A --field-selector spec.nodeName=control-00,status.phase=Failed
```

---

### 3.2 Window 2: `worker-00` (`192.168.2.204`, k3s agent)

**Special notes for `worker-00`:**
- **Ceph degraded window**: `osd.0` and `mon-f` go offline; `mon` quorum drops
  to `2/3` (`d,g`) and PGs enter `active+undersized+degraded` until `worker-00`
  returns and `osd.0` marks back `up`.
- **Workload impact**: `romm`, `lan-dns` (1 of 2), and 6 CNPG replicas evict
  and reschedule/rebuild on peer nodes; `silo` (pinned via
  `kubernetes.io/hostname: worker-00` for Intel `gpu.intel.com/i915`) and
  `gitea-valkey-cluster-2` (`local-path`) wait `Pending` during the ~20s reboot
  and resume on `worker-00` after uncordon. If `hermes` landed on `worker-00`
  during Window 1, draining `worker-00` moves `hermes` again (brief chat blip).

**Commands:**

```fish
# 1. Agent confirms Ceph entry gate (quorum 3/3, 3 osds up/in, 33 active+clean)
# 2-3. User cordons and drains from laptop (fish):
kubectl cordon worker-00
kubectl drain worker-00 --ignore-daemonsets --delete-emptydir-data --timeout=10m
# If kritika-*-* (0/1 Running) blocks drain under pdb/kritika:
#   kubectl -n kritika get pods -o wide --field-selector spec.nodeName=worker-00
#   kubectl -n kritika delete pod <kritika-pod-on-worker-00>
#   kubectl drain worker-00 --ignore-daemonsets --delete-emptydir-data --timeout=10m
```

After the agent confirms only DaemonSet pods remain Running on `worker-00`, run
on `worker-00` (`ssh szkud@192.168.2.204`, substituting `<token>` from
`/var/lib/rancher/k3s/server/node-token` on `control-00` per `add-cluster-node.md`):

```sh
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION=v1.36.6+k3s1 \
  K3S_URL=https://192.168.2.32:6443 \
  K3S_TOKEN='<token>' \
  sh -

k3s --version    # expect: k3s version v1.36.6+k3s1

sudo systemctl stop unattended-upgrades
sudo systemctl reboot
```

Once `worker-00` is `Ready,SchedulingDisabled` at `v1.36.6+k3s1`:

```sh
# On worker-00: re-check drop-in + inhibitor lock BEFORE uncordoning
test -f /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf && echo kubelet-dropin=ok || echo kubelet-dropin=MISSING
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager InhibitDelayMaxUSec
systemd-inhibit --list | grep -i kubelet
sudo journalctl -b -1 -o short-precise | tail -20
ps -eo stat,pid,comm | awk '$1 ~ /^D/'
```

If `kubelet-dropin=MISSING`, re-apply per Section 2 Step 8 and
`sudo systemctl restart k3s-agent`. Then from the laptop (`fish`):

```fish
kubectl uncordon worker-00
# Wait for agent exit gate (Ceph back to quorum 3/3 + 33 active+clean, 7 CNPG clusters 3/3, silo + gitea-valkey-cluster-2 Running):
kubectl delete pods -A --field-selector spec.nodeName=worker-00,status.phase=Failed
```

---

### 3.3 Window 3: `worker-01` (`192.168.2.117`, k3s agent)

**Special notes for `worker-01`:**
- **Ceph degraded window and mon leader step-down**: `osd.1` and `mon-d`
  (quorum leader at recon) go offline; remaining mons (`f,g`) hold `2/3` quorum
  and elect a new leader automatically while PGs run
  `active+undersized+degraded`. Do **not** start this window unless `worker-00`
  (`mon-f`, `osd.0`) is fully back in `3/3` quorum and all `33` PGs are
  `active+clean`.
- **Workload impact**: `continuwuity-0` (pinned, `local-path` Matrix homeserver
  data; Matrix messaging pauses for the window) and `plex` (pinned `i915`,
  pre-existing `ImagePullBackOff` / `Pending`; do not block on it) stay down
  until `worker-01` returns and is uncordoned. `cnpg-silo-2` evicts and rebuilds
  on a peer. `livekit` (`hostNetwork`) and `coturn` go down for the window; the
  UDM port forwards (`UDP 50100` and `TCP 7881` -> `192.168.2.117`) live in
  UniFi Network settings and keep pointing at `192.168.2.117`, so nothing needs
  repointing.

**Commands:**

```fish
# 1. Agent confirms Ceph entry gate (quorum 3/3, 3 osds up/in, 33 active+clean)
# 2-3. User cordons and drains from laptop (fish):
kubectl cordon worker-01
kubectl drain worker-01 --ignore-daemonsets --delete-emptydir-data --timeout=10m
```

After the agent confirms only DaemonSet pods remain Running on `worker-01`, run
on `worker-01` (`ssh szkud@192.168.2.117`):

```sh
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION=v1.36.6+k3s1 \
  K3S_URL=https://192.168.2.32:6443 \
  K3S_TOKEN='<token>' \
  sh -

k3s --version    # expect: k3s version v1.36.6+k3s1

sudo systemctl stop unattended-upgrades
sudo systemctl reboot
```

Once `worker-01` is `Ready,SchedulingDisabled` at `v1.36.6+k3s1`:

```sh
# On worker-01: re-check drop-in + inhibitor lock BEFORE uncordoning
test -f /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf && echo kubelet-dropin=ok || echo kubelet-dropin=MISSING
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager InhibitDelayMaxUSec
systemd-inhibit --list | grep -i kubelet
sudo journalctl -b -1 -o short-precise | tail -20
ps -eo stat,pid,comm | awk '$1 ~ /^D/'
```

If `kubelet-dropin=MISSING`, re-apply per Section 2 Step 8 and
`sudo systemctl restart k3s-agent`. Then from the laptop (`fish`):

```fish
kubectl uncordon worker-01
# Wait for agent exit gate (Ceph back to quorum 3/3 + 33 active+clean, 7 CNPG clusters 3/3, continuwuity-0 + livekit + coturn Running):
kubectl delete pods -A --field-selector spec.nodeName=worker-01,status.phase=Failed
```

---

### 3.4 Window 4: `worker-02` (`192.168.2.60`, k3s agent)

**Special notes for `worker-02`:**
- **Ceph degraded window**: `osd.2` and `mon-g` go offline; `mon` quorum is
  `2/3` (`d,f`) and PGs run `active+undersized+degraded` for the window.
- **Public ingress data plane (`wildcard-gregbob-net`, VIP `192.168.2.9`)**:
  currently runs on `worker-02` as a single unpinned pod. Draining `worker-02`
  reschedules `wildcard-gregbob-net` to another node with a brief HTTPS blip
  while Cilium BGP updates VIP `192.168.2.9`. Explicitly verify VIP `192.168.2.9`
  answers both right after drain and after uncordon.
- **Other workloads**: `jellyfin` (pinned to `worker-02` for Lunar Lake
  `gpu.intel.com/xe` and `local-path` cache) stays down until uncordon; 3 CNPG
  replicas (`cnpg-pocket-id-3`, `cnpg-romm-7`, `cnpg-silo-3`) rebuild on peers;
  `gitea-valkey-cluster-1` (`ceph-block`), `external-secrets`, `k8s-gateway`
  (1 of 2), `local-path-provisioner`, `snapshot-controller`, and 1 of 2
  `kritika` pods move (use the Section 2 Step 3 targeted `kritika` pod delete if
  `cnpg-kritika` is still broken and `pdb/kritika` blocks drain).

**Commands:**

```fish
# 1. Agent confirms Ceph entry gate (quorum 3/3, 3 osds up/in, 33 active+clean)
# 2-3. User cordons and drains from laptop (fish):
kubectl cordon worker-02
kubectl drain worker-02 --ignore-daemonsets --delete-emptydir-data --timeout=10m
# If kritika-*-* (0/1 Running) blocks drain under pdb/kritika:
#   kubectl -n kritika get pods -o wide --field-selector spec.nodeName=worker-02
#   kubectl -n kritika delete pod <kritika-pod-on-worker-02>
#   kubectl drain worker-02 --ignore-daemonsets --delete-emptydir-data --timeout=10m

# Spot-check that wildcard-gregbob-net rescheduled and VIP 192.168.2.9 answers:
kubectl -n network get pods -o wide
curl -skI --resolve id.gregbob.net:443:192.168.2.9 https://id.gregbob.net | head -n 5
```

After the agent confirms only DaemonSet pods remain Running on `worker-02`, run
on `worker-02` (`ssh szkud@192.168.2.60`):

```sh
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION=v1.36.6+k3s1 \
  K3S_URL=https://192.168.2.32:6443 \
  K3S_TOKEN='<token>' \
  sh -

k3s --version    # expect: k3s version v1.36.6+k3s1

sudo systemctl stop unattended-upgrades
sudo systemctl reboot
```

Once `worker-02` is `Ready,SchedulingDisabled` at `v1.36.6+k3s1`:

```sh
# On worker-02: re-check drop-in + inhibitor lock BEFORE uncordoning
test -f /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf && echo kubelet-dropin=ok || echo kubelet-dropin=MISSING
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager InhibitDelayMaxUSec
systemd-inhibit --list | grep -i kubelet
sudo journalctl -b -1 -o short-precise | tail -20
ps -eo stat,pid,comm | awk '$1 ~ /^D/'
```

If `kubelet-dropin=MISSING`, re-apply per Section 2 Step 8 and
`sudo systemctl restart k3s-agent`. Then from the laptop (`fish`):

```fish
kubectl uncordon worker-02
# Wait for agent exit gate (Ceph back to quorum 3/3 + 33 active+clean, 7 CNPG clusters 3/3, jellyfin Running, VIP 192.168.2.9 answering):
curl -skI --resolve id.gregbob.net:443:192.168.2.9 https://id.gregbob.net | head -n 5
kubectl delete pods -A --field-selector spec.nodeName=worker-02,status.phase=Failed
```

---

### 3.5 Window 5: `ai-00` (`192.168.2.90`, GPU agent, LAST)

**Special notes for `ai-00`:**
- **Executed LAST; agent offline during window**: `ai-00` runs
  `ai-system/radiance` (serving `llm.gregbob.net` model `local` for `hermes`
  and `agentic-workflow` one-shots). Once `ai-00` drains, `Radiance` stops and
  the agent is offline until `ai-00` is uncordoned and `radiance` returns to
  `1/1 Running`. The user runs all checks and commands in this window from the
  laptop and messages the agent once `radiance` is back up.
- **No Ceph impact**: `ai-00` hosts no Ceph mon or OSD; Ceph stays `HEALTH_OK`
  with `33 active+clean` PGs throughout.
- **Workloads and GPU host config**: `radiance` (`radiance-models` PVC is
  `local-path` on `ai-00`) stays pinned to `ai-00` and restarts after uncordon;
  `dreamcast` Moonlight streaming (VIP `192.168.2.11`) is down for the window.
  Both the `amd.com/gpu=present:NoSchedule` taint and `biggs.sz/role=ai` label
  come from `/etc/rancher/k3s/config.yaml` on `ai-00` (and `LimitMEMLOCK=infinity`
  from `/etc/systemd/system/k3s-agent.service.d/memlock.conf`), neither of which
  is overwritten by `get.k3s.io`. Confirm `/etc/rancher/k3s/config.yaml` before
  upgrading and confirm the taint, label, and GPU allocatable counts before and
  after uncordoning.

**Commands (user runs end-to-end from laptop `fish` + SSH to `192.168.2.90`):**

```fish
# 1. Pre-window gate on laptop (fish): confirm Ceph 33 active+clean and nodes 1-4 on v1.36.6+k3s1
kubectl get nodes -o wide
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s

# 2-4. Cordon, drain, and confirm only DaemonSet pods remain Running on ai-00:
kubectl cordon ai-00
kubectl drain ai-00 --ignore-daemonsets --delete-emptydir-data --timeout=10m
kubectl get pods -A -o wide --field-selector spec.nodeName=ai-00
```

On `ai-00` (`ssh szkud@192.168.2.90`):

```sh
# Confirm GPU taint/label config.yaml and memlock drop-in are in place before install.sh
cat /etc/rancher/k3s/config.yaml
cat /etc/systemd/system/k3s-agent.service.d/memlock.conf

curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION=v1.36.6+k3s1 \
  K3S_URL=https://192.168.2.32:6443 \
  K3S_TOKEN='<token>' \
  sh -

k3s --version    # expect: k3s version v1.36.6+k3s1

sudo systemctl stop unattended-upgrades
sudo systemctl reboot
```

Once `ai-00` returns (~20s) and `kubectl get node ai-00 -o wide` on the laptop
shows `Ready,SchedulingDisabled` at `v1.36.6+k3s1`, verify on `ai-00`:

```sh
test -f /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf && echo kubelet-dropin=ok || echo kubelet-dropin=MISSING
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager InhibitDelayMaxUSec
systemd-inhibit --list | grep -i kubelet
grep 'locked memory' /proc/$(pgrep -xo k3s-agent || pgrep -o k3s)/limits
sudo journalctl -b -1 -o short-precise | tail -20
ps -eo stat,pid,comm | awk '$1 ~ /^D/'
```

If `kubelet-dropin=MISSING`, re-apply per Section 2 Step 8 and
`sudo systemctl restart k3s-agent`. Confirm taint and label from the laptop
(`fish`), then uncordon and wait for `radiance` to come back:

```fish
kubectl get node ai-00 -o jsonpath='{.spec.taints}{"\n"}{.metadata.labels}{"\n"}'
kubectl uncordon ai-00
kubectl -n ai-system get pods -o wide -w
# Once radiance is 1/1 Running, verify GPU allocatable resources and sweep Failed pods:
kubectl get node ai-00 -o jsonpath='{.status.allocatable}' | tr ',' '\n' | grep -E 'amd.com|squat.ai'
kubectl delete pods -A --field-selector spec.nodeName=ai-00,status.phase=Failed
```

Expected allocatable on `ai-00`: `amd.com/gpu-ai-pro-r9700: "2"`,
`amd.com/gpu: "1"` (console iGPU, unused), `squat.ai/r9700-a: "8"`,
`squat.ai/r9700-b: "8"`, `squat.ai/uinput: "16"`. Report back to the `hermes`
agent to run Section 6 final fleet verification.

---

## 4. Expected transient states (do not treat as incidents)

- **Ceph `HEALTH_WARN` (`active+undersized+degraded`, mon quorum `2/3`) during
  each worker window**: `rook-ceph` has pool size `3`, `failureDomain: host`,
  and exactly three OSD hosts (`worker-00`, `worker-01`, `worker-02`). Taking
  any worker down drops one mon and one OSD; the remaining two copies continue
  serving reads and writes safely, and all `33` PGs recover to `active+clean`
  within 1-2 minutes after the worker reboots and is uncordoned.
- **Mon leader re-election on `worker-01`**: `mon-d` on `worker-01` leads
  quorum; draining/rebooting `worker-01` triggers a brief election between
  `mon-f` and `mon-g`.
- **CNPG replica eviction and rebuild**: every CNPG PVC uses `local-path`.
  Draining a node evicts its CNPG pods; if a primary was on that node, CNPG
  promotes an existing replica automatically (`enablePDB: true`) and provisions
  a fresh replacement replica on another node, dropping the old node-local PV.
- **`NodeShutdown` `Failed` pod tombstones**: during shutdown, ReplicaSets retry
  scheduling onto the departing node and kubelet rejects admissions with
  `reason: NodeShutdown` (typically 50-200 records, mostly `cilium-operator`).
  These are harmless bookkeeping records cleared at Step 10 of each window.
- **`control-00` 2-minute boot pause and worker NFS freeze**: `control-00` waits
  120s in `systemd-networkd-wait-online.service` for unplugged `enp1s0f0` before
  starting `k3s.service`; worker pods with `hard` mounts to `192.168.2.32:/`
  pause I/O until `nfs-server` returns.
- **180s shutdown pause if `unattended-upgrades` is still running**:
  `unattended-upgrades` holds a logind delay lock up to `InhibitDelayMaxSec=180`;
  stopping `unattended-upgrades` right before `systemctl reboot` avoids waiting
  out that timer while keeping kubelet's own 180s inhibitor intact.

---

## 5. Rollback (`v1.36.6+k3s1` -> `v1.34.3+k3s1`, break-glass only)

Rollback is out of scope of planned execution. Per
<https://docs.k3s.io/upgrades/roll-back> and
<https://docs.k3s.io/datastore/backup-restore>, rolling back across Kubernetes
minor versions (`1.36` -> `1.34`) **cannot** be done by swapping the `k3s`
binary alone: you must downgrade the binary on every upgraded node **and**
restore the pre-upgrade `v1.34.3+k3s1` datastore snapshot/backup from Section
1.3. Any cluster state written after the pre-upgrade backup is lost on restore.

1. If the API server is reachable, drain workloads from the laptop (`fish`):
   ```fish
   for n in ai-00 worker-02 worker-01 worker-00 control-00
     kubectl drain $n --ignore-daemonsets --delete-emptydir-data --timeout=10m
   end
   ```
2. On every upgraded node, stop k3s and running pod processes (warning:
   `k3s-killall.sh` forcefully terminates container processes):
   ```sh
   sudo /usr/local/bin/k3s-killall.sh
   ```
3. Downgrade the `k3s` binary on each upgraded node **without starting** the
   service (`INSTALL_K3S_SKIP_START=true`):
   - On `control-00`:
     ```sh
     curl -sfL https://get.k3s.io | \
       INSTALL_K3S_VERSION=v1.34.3+k3s1 \
       INSTALL_K3S_SKIP_START=true \
       sh -s - server \
         --flannel-backend=none \
         --disable-kube-proxy \
         --disable=servicelb \
         --disable-network-policy \
         --disable=traefik
     ```
   - On each upgraded agent (`worker-00`, `worker-01`, `worker-02`, `ai-00`):
     ```sh
     curl -sfL https://get.k3s.io | \
       INSTALL_K3S_VERSION=v1.34.3+k3s1 \
       INSTALL_K3S_SKIP_START=true \
       K3S_URL=https://192.168.2.32:6443 \
       K3S_TOKEN='<token>' \
       sh -
     ```
4. Restore the `v1.34.3+k3s1` datastore on `control-00`:
   - **SQLite/kine datastore (live `cluster0` configuration)**:
     ```sh
     sudo mv /var/lib/rancher/k3s/server/db /var/lib/rancher/k3s/server/db.failed-1.36
     sudo mkdir -p /var/lib/rancher/k3s/server/db
     sudo chmod 700 /var/lib/rancher/k3s/server/db
     sudo cp -a /var/backups/k3s-pre-1.36.6/state-v1.34.3.db /var/lib/rancher/k3s/server/db/state.db
     sudo cp -a /var/backups/k3s-pre-1.36.6/token-v1.34.3 /var/lib/rancher/k3s/server/token
     ```
   - **Embedded etcd reference** (only if `cluster0` is ever migrated to
     `--cluster-init` embedded etcd, per `docs.k3s.io/upgrades/roll-back`): run
     `sudo k3s server --cluster-reset --cluster-reset-restore-path=<PATH-TO-V1.34-SNAPSHOT>`
     on `control-00` and wait for the reset-complete exit before starting `k3s`.
5. Start `k3s` on `control-00` (`sudo systemctl start k3s`), confirm
   `k3s --version` and `kubectl get nodes` show `control-00` on `v1.34.3+k3s1`,
   then start `k3s-agent` on each upgraded agent (`sudo systemctl start k3s-agent`),
   re-check `10-graceful-shutdown.conf` on every touched node, uncordon all
   nodes, and run Section 6 health checks.

---

## 6. Final fleet verification

Once all five windows are complete and `Radiance` is back up on `ai-00`, the
agent runs the read-only cluster verification and the user runs the 5-node host
drop-in check:

```sh
# 1. All 5 nodes Ready, uncordoned, and running v1.36.6+k3s1
kubectl get nodes -o wide

# 2. Ceph HEALTH_OK, mon quorum 3/3, 3 osds up/in, 33 active+clean PGs
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree

# 3. All 7 active CNPG clusters 3/3 'Cluster in healthy state' (aside from pre-existing cnpg-kritika)
kubectl -n cnpg-system get clusters.postgresql.cnpg.io

# 4. Flux sources and Kustomizations Ready (matching pre-flight baseline)
flux get sources all
kubectl get kustomizations -A | grep -v True

# 5. Zero unexpected non-Running pods and zero orphaned PVs
kubectl get pods -A | grep -vE 'Running|Completed'
kubectl get pv | grep -v Bound

# 6. Core DaemonSets and ai-00 GPU resources intact
kubectl -n kube-system get ds cilium cilium-envoy node-feature-discovery-worker
kubectl get node ai-00 -o jsonpath='{.spec.taints}{"\n"}{.metadata.labels}{"\n"}{.status.allocatable}{"\n"}'
```

User host-side and public/LAN route spot-checks from the laptop (`fish`):

```fish
# Confirm graceful-shutdown drop-ins and kubelet inhibitor locks survived across all 5 upgraded nodes
for ip in 192.168.2.164 192.168.2.204 192.168.2.117 192.168.2.60 192.168.2.90
  echo "=== $ip ==="
  ssh szkud@$ip 'hostname; k3s --version | head -n 1; test -f /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf && echo kubelet-dropin=present || echo kubelet-dropin=MISSING; systemd-inhibit --list | grep -i kubelet || echo kubelet-lock=MISSING'
end

# Spot-check public routes via wildcard-gregbob-net (VIP 192.168.2.9) and LAN DNS (VIP 192.168.2.8)
for host in id.gregbob.net chat.gregbob.net hermes.gregbob.net
  echo "=== $host ==="
  curl -skI https://$host | head -n 5
end
dig @192.168.2.8 id.gregbob.net +short
```
