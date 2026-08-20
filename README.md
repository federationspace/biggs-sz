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
- Storage classes:
  - `local-path` — default, k3s built-in, node-local SSD.
  - `ceph-block` — [Rook-Ceph](https://rook.io/), for workloads that need
    replicated block storage independent of any one node.
  - `nfs` — external NFS share, for shared/media volumes.
- Media apps that need Intel iGPU hardware transcoding (`jellyfin`, etc.)
  are pinned via `kubernetes.io/hostname` nodeSelectors to the workers that
  have the iGPU (see `intel-gpu-plugin` / `nfd` in `kube-system`).
- Networking: [Cilium](https://cilium.io/) provides the CNI, and
  `CiliumLoadBalancerIPPool` + BGP advertisement (in
  `kube-system/cilium/bgp/`) hand out `LoadBalancer` service IPs from the
  `192.168.2.0/24` range via L2/BGP — **not** MetalLB (a MetalLB Helm
  repository source still exists in `flux-system/sources` but is currently
  unused/legacy).
- Ingress/exposure (`network/` namespace):
  - `k8s-gateway` — Gateway API implementation; HTTPRoutes reference the
    shared Gateway `wildcard-gregbob-net` in the `network` namespace by name.
  - `cloudflared` — Cloudflare Tunnel, terminating `*.gregbob.net` (+ apex)
    proxied traffic and forwarding HTTP-only to
    `wildcard-gregbob-net.network.svc:80` inside the cluster. There is no
    port-forwarded ingress from the internet other than SSH; everything
    public rides the tunnel.
  - `agentgateway` — gateway for AI/agent-facing traffic.
- Secrets: [External Secrets Operator](https://external-secrets.io/) synced
  from a 1Password vault via `onepassword-connect`
  (`ClusterSecretStore: onepassword-connect`). Nothing is hardcoded in Git.
- Certificates: cert-manager with a `letsencrypt-prod` `ClusterIssuer` using
  Cloudflare DNS-01 challenges.

## Applications by namespace

| Namespace | Apps |
|---|---|
| `ai-system` | vllm, kagent, substrate, embeddings, exa-mcp, flux-mcp, victoria-metrics-mcp, mindwtr-mcp, codebase-memory-mcp, agent-sandbox, csi-driver |
| `cert-manager` | cert-manager |
| `databases` | cnpg (CloudNativePG) |
| `external-secrets` | external-secrets, onepassword-connect |
| `git-system` | gitea, act_runner |
| `gregbob` | gregbob (personal site/services + IRC) |
| `kube-system` | cilium, nfs, nfd, intel-gpu-plugin, volsync, snapshot-controller |
| `matrix` | continuwuity, sable |
| `media` | jellyfin, plex, sonarr, radarr, lidarr, readarr, prowlarr, sabnzbd, ombi, homarr, romm, rreading-glasses, epub-only, media-storage |
| `netbird-client` | client (NetBird mesh VPN agent) |
| `network` | agentgateway, k8s-gateway, cloudflared |
| `observability` | victoria-metrics, victoria-logs, grafana-operator |
| `renovate` | renovate (self-hosted, keeps chart/image pins current) |
| `rook-ceph` | rook-ceph (Ceph operator + cluster, backs `ceph-block` SC) |

## Repo conventions

Each app lives at `clusters/cluster0/kubernetes/apps/<namespace>/<app>/`:

```
<app>/
  ks.yaml   # one or more Flux Kustomizations (path -> ./app, targetNamespace,
            # prune: true, wait: false); multi-stage apps chain several
            # Kustomizations in one ks.yaml with dependsOn (e.g. cert-manager:
            # chart, then issuers)
  app/      # raw manifests: Deployment/HelmRelease, Service, ExternalSecret, ...
            # (no inner kustomization.yaml)
```

`<namespace>/kustomization.yaml` lists each app's `ks.yaml`; adding an app
means adding one line there (the namespace itself is auto-discovered by the
root Flux Kustomization, no further registration needed).

`renovate.json` scans `clusters/**.yaml` for Flux/Helm-chart/image versions
and opens PRs; automerge is branch-based, dashboard on GitHub Issues.

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
