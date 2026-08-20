# Biggs is [Joe](https://github.com/shrinedogg)'s dog.

He's a good boy. Joe's own homelab repo, [`biggs.dog`](https://github.com/shrinedogg/biggs.dog),
was the starting point I used to build up my Kubernetes and home-server
skills — this repo grew out of that base. As the cluster became mine, I
registered `gregbob.net` to host the services and sites I've since built on
top of it.

# What is this?

This is a mono-repository for my home infrastructure and Kubernetes cluster.
It follows Infrastructure as Code (IaC) and GitOps practices via [Flux CD](https://fluxcd.io/):
everything the cluster runs is declared here as YAML, and Flux reconciles the
live cluster to match `main`. There is no application source code in this
repo — only declarative infrastructure.

Flux is bootstrapped via the [flux-operator](https://github.com/controlplaneio-fluxcd/flux-operator)
(`FluxInstance`), tracking `refs/heads/main` at path `clusters/cluster0`. The
root Kustomization auto-discovers every `clusters/cluster0/kubernetes/apps/<namespace>/`
directory — there is no central app registry to edit when adding a namespace.

## Design choices

I made some hard choices based on my environment that may not appeal to you
or your use case.

My NAS is a bare-metal host that, besides a ZFS pool, also hosts my k3s
control plane (`control-00`); I do this because I host pods on the control
plane related to media management and downloading. This avoids downloading
directly to the HDDs in my ZFS pool — instead files stage on the node's
local SSD and move to the ZFS pool via local disk transfer, sidestepping my
limited 1Gbps networking equipment. This introduces stickiness, but the goal
of this cluster is not to give these applications availability decoupled
from the host; it's to clusterize and codify a bunch of homelab services that
would otherwise be hard to manage. If my NAS is down, the media pods aren't
worth much anyway, so that's stickiness I can live with.

## Cluster layout

- Single k3s control plane node: `control-00` (the NAS, see above).
- Worker nodes: `worker-00`, `worker-01`, `worker-05`.
- Note: `CiliumLoadBalancerIPPool` + BGP handles `LoadBalancer` IPs —
  **not** MetalLB (a MetalLB Helm repository source still exists in
  `flux-system/sources` but is currently unused/legacy).

See **Core components** below for storage, networking, secrets, and
certificate details.

## Repository structure

```
clusters/cluster0/
├── flux-system/                # FluxInstance + Helm/OCI/Git repository sources
└── kubernetes/apps/
    ├── ai-system/               # agent-sandbox, codebase-memory-mcp, csi-driver, embeddings,
    │                            # exa-mcp, flux-mcp, kagent(-crds), mindwtr-mcp, substrate(-crds),
    │                            # victoria-metrics-mcp, vllm
    ├── cert-manager/            # cert-manager (ACME/DNS-01 issuers)
    ├── databases/                # cnpg (CloudNativePG)
    ├── external-secrets/         # external-secrets, onepassword-connect
    ├── git-system/                # gitea, act_runner
    ├── gregbob/                   # gregbob — personal site/services + IRC
    ├── kube-system/                # cilium (CNI + BGP/L2), nfs, nfd, intel-gpu-plugin,
    │                              # volsync, snapshot-controller
    ├── matrix/                    # continuwuity, sable
    ├── media/                     # jellyfin, plex, sonarr, radarr, lidarr, readarr, prowlarr,
    │                             # sabnzbd, ombi, homarr, romm, rreading-glasses, epub-only,
    │                             # media-storage
    ├── netbird-client/            # client — NetBird mesh VPN agent
    ├── network/                   # agentgateway, k8s-gateway, cloudflared
    ├── observability/             # victoria-metrics, victoria-logs, grafana-operator
    ├── renovate/                  # renovate — self-hosted, keeps chart/image pins current
    └── rook-ceph/                 # rook-ceph — Ceph operator + cluster, backs `ceph-block` SC
```

## Core components

### Networking

| Component | Description |
|---|---|
| [Cilium](https://cilium.io/) | CNI; `CiliumLoadBalancerIPPool` + BGP advertisement (`kube-system/cilium/bgp/`) hand out `LoadBalancer` IPs from `192.168.2.0/24` |
| [k8s-gateway](https://github.com/ori-edge/k8s_gateway) | Gateway API implementation; HTTPRoutes attach to the shared Gateway `wildcard-gregbob-net` in `network` by name |
| [cloudflared](https://github.com/cloudflare/cloudflared) | Cloudflare Tunnel; terminates proxied `*.gregbob.net` (+ apex) traffic and forwards HTTP-only to `wildcard-gregbob-net.network.svc:80` — no other internet-facing ingress besides SSH |
| agentgateway | Gateway for AI/agent-facing traffic |

### Identity & secrets

| Component | Description |
|---|---|
| [External Secrets Operator](https://external-secrets.io/) | Syncs secrets from 1Password into the cluster via a `ClusterSecretStore` |
| onepassword-connect | 1Password Connect server; backs the `onepassword-connect` `ClusterSecretStore`, vault `biggs-sz` |
| [cert-manager](https://cert-manager.io/) | `letsencrypt-prod` `ClusterIssuer` via Cloudflare DNS-01 |

### Storage

| Component | Description |
|---|---|
| `local-path` | k3s built-in, default StorageClass, node-local SSD |
| [Rook-Ceph](https://rook.io/) | `ceph-block` StorageClass; replicated block storage independent of any one node |
| NFS | external NFS share, `nfs` StorageClass, shared/media volumes |
| [volsync](https://volsync.readthedocs.io/) | volume backup/replication (`kube-system`) |

### System

| Component | Description |
|---|---|
| [Node Feature Discovery](https://kubernetes-sigs.github.io/node-feature-discovery/) | Hardware feature detection, used to target iGPU-capable workers |
| intel-gpu-plugin | Intel iGPU device plugin — exposes hardware transcoding to `jellyfin`/media workloads, pinned via `kubernetes.io/hostname` nodeSelectors |

### Observability

| Component | Description |
|---|---|
| [Victoria Metrics](https://victoriametrics.com/) | Metrics storage and monitoring |
| [Victoria Logs](https://docs.victoriametrics.com/victorialogs/) | Log storage |
| [Grafana Operator](https://grafana.github.io/grafana-operator/) | Grafana deployment and dashboard management |

### Automation

| Component | Description |
|---|---|
| [Renovate](https://docs.renovatebot.com/) | Self-hosted; scans `clusters/**.yaml` for Flux/Helm-chart/image version bumps; automerge is branch-based, dashboard on GitHub Issues |

## App structure pattern

Each app lives at `clusters/cluster0/kubernetes/apps/<namespace>/<app>/`:

```
<namespace>/
├── kustomization.yaml    # lists each app's ks.yaml; adding an app = one line here
├── namespace.yaml        # namespace definition
└── <app>/
    ├── ks.yaml            # one or more Flux Kustomizations (path -> ./app,
    │                      # targetNamespace, prune: true, wait: false);
    │                      # multi-stage apps chain several Kustomizations in
    │                      # one ks.yaml with dependsOn (e.g. cert-manager:
    │                      # chart, then issuers)
    └── app/               # raw manifests: Deployment/HelmRelease, Service,
                            # ExternalSecret, ... (no inner kustomization.yaml)
```

The namespace directory itself is auto-discovered by the root Flux
Kustomization — there is no central app registry to edit when adding one.

## Secret management

Secrets follow a two-tier model:

1. **1Password + External Secrets Operator** — the primary path for
   application secrets. `ExternalSecret` resources pull from a 1Password
   vault (`biggs-sz`) through `onepassword-connect`, referencing the
   `onepassword-connect` `ClusterSecretStore`. This is how nearly everything
   (API keys, app credentials, tokens) reaches the cluster — nothing is
   hardcoded in plaintext in Git.
2. **SOPS with age encryption** — used for the small bootstrap set of secrets
   that External Secrets itself depends on (the 1Password Connect credentials
   file and API token), since those can't be chicken-and-egg sourced from
   1Password. Encrypted in place under
   `external-secrets/onepassword-connect/app/`; only `data`/`stringData`
   fields are encrypted (`encrypted_regex` in the SOPS metadata), so resource
   shape stays diffable in PRs.

## Hardcoded values to change if you fork this

- `kubernetes.io/hostname: control-00` / `worker-00` / `worker-01` / `worker-05`
  — node pins for control-plane-hosted and iGPU-transcoding workloads.
- `CiliumLoadBalancerIPPool` blocks in `kube-system/cilium/bgp/bgp-config.yaml`
  — the LoadBalancer IP range.
- `provisioner: nfs` / NFS server IP — your NFS export.
- `vaults:` in ExternalSecret/SecretStore resources — your 1Password vault name.
- `wildcard-gregbob-net` Gateway name and `*.gregbob.net` / `biggs.dog` hosts
  in HTTPRoutes — your own domain(s).
- `sync.url` in `clusters/cluster0/flux-system/flux-instance.yaml` — your fork's URL.
- The `age` recipient block inside the two SOPS-encrypted secrets under
  `external-secrets/onepassword-connect/app/` — re-encrypt for your own age
  key (there's no root `sops.yaml`/`.sops.yaml` config here; each file
  carries its own `sops:` metadata), or replace them with plaintext
  bootstrapped out-of-band.

# Setup

First, you'll need Kubernetes.

### Install k3s

On the intended control-plane node:

```sh
curl -sfL https://get.k3s.io | sh -s server --disable servicelb --disable traefik
```

(`servicelb`/`traefik` are disabled because Cilium handles LoadBalancer IPs
and this repo brings its own gateway.) The `K3S_TOKEN` for joining workers is
at `/var/lib/rancher/k3s/server/node-token` on the control node.

On each worker node:

```sh
curl -sfL https://get.k3s.io | K3S_URL=https://<control-plane-ip>:6443 K3S_TOKEN=<token> sh -
```

### Bootstrap Flux

This repo uses the [flux-operator](https://github.com/controlplaneio-fluxcd/flux-operator)
`FluxInstance` CRD rather than `flux bootstrap` directly. Install the
flux-operator, then apply `clusters/cluster0/flux-system/` (which contains
the `FluxInstance` plus its `GitRepository`/`HelmRepository`/`OCIRepository`
sources) against your cluster, pointing `spec.sync.url` at your fork and
`spec.sync.pullSecret` at a secret with GitHub read access.

From there, Flux reconciles everything under `clusters/cluster0/kubernetes/apps/`
automatically — no per-app bootstrap step required.
