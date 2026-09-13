# AGENTS.md: biggs-sz

Guidance for AI coding agents working in this repository.

## What this repo is

Flux CD GitOps repo for a single k3s homelab cluster (`cluster0`). All desired
cluster state lives here as YAML; Flux reconciles it. There is no app source
code here, only declarative infrastructure.

- `clusters/cluster0/flux-system/`: Flux itself (`FluxInstance` +
  Git/Helm/OCI repository sources).
- `clusters/cluster0/kubernetes/apps/<namespace>/`: applications grouped by
  namespace.
- `docs/runbooks/`, `docs/postmortems/`: operational procedures and incident
  writeups. Read the relevant runbook before node work.
- `renovate.json`: Renovate config. The flux and helm-values managers scan
  `clusters/**.yaml`; automerge is branch-based, dashboard on GitHub Issues.

## The golden rules (read before changing anything)

1. Edit YAML in Git; never mutate the cluster. Use kubectl to inspect live
   state, but make every persistent change here and let Flux converge.
2. Flux tracks `main`. Nothing reconciles until merged to `main`. Do not
   promise a fix is "live" until then.
3. Secrets via External Secrets + 1Password. Never hardcode credentials. Add
   an `ExternalSecret` against ClusterSecretStore `onepassword-connect` whose
   `remoteRef` matches the 1Password item and field names exactly. If the item
   does not exist yet, that is a prerequisite: say so.

## App layout convention

Each app is one or more Flux `Kustomization` resources pointing at raw
manifests:

```
kubernetes/apps/<ns>/<app>/
  ks.yaml        # Flux Kustomization(s); several can share one file
  app/           # raw manifests (Deployment, HelmRelease, ExternalSecret, ...)
```

- `ks.yaml` sets `targetNamespace: <ns>`, `prune: true`, `wait: false` (use
  `wait: true` only where a dependent Kustomization needs health gating, e.g.
  `lan-dns` after `k8s-gateway`),
  `path: ./clusters/cluster0/kubernetes/apps/<ns>/<app>/app/`, and
  `commonMetadata.labels.app.kubernetes.io/name: <app>`.
- The `app/` directory holds raw manifests with **no inner
  `kustomization.yaml`**; Flux builds the directory directly.
- Multi-stage apps put several Kustomizations in one `ks.yaml` with
  `dependsOn` for ordering (see `cert-manager`: chart first, then issuers).
- The `<ns>/kustomization.yaml` lists each app's `ks.yaml`; add new apps there.
- A **new namespace directory** needs no central registration: the root Flux
  Kustomization (path `clusters/cluster0`) auto-discovers
  `apps/<ns>/`. It does need its own `kustomization.yaml` listing
  `namespace.yaml` plus each app `ks.yaml`; without one, Flux recurses into
  `app/` and a single unknown kind fails the whole dry-run.

## Cluster specifics that bite

- **Nodes**: `control-00` (single k3s control plane, also the NAS host),
  `worker-00`, `worker-01`, `worker-02`. `worker-05` was retired; stale
  references to it and to `control-01` are bugs, not history.
- The control plane hosts media pods on purpose: downloads stage on the
  node's local SSD, then move to the ZFS pool locally instead of over the
  1Gbps network. Most `*arr` apps and `sabnzbd` pin to `control-00`;
  `jellyfin` pins to `worker-01` and `plex` to `worker-00` for Intel iGPU
  hardware transcoding; `continuwuity` pins to `worker-01`.
- **StorageClasses**: `local-path` (k3s built-in, **default**, node-local SSD),
  `ceph-block` (Rook-Ceph RBD, replicated, node-independent),
  `nfs-storage` (`provisioner: nfs`, shared media volumes from the NAS).
  There is no host-path StorageClass.
- **LoadBalancer IPs come from Cilium**, not MetalLB. `CiliumLoadBalancerIPPool`
  `pool` in `kube-system/cilium/bgp/bgp-config.yaml` hands out
  `192.168.2.6-192.168.2.254`, advertised over BGP to the UDM. Pin a VIP with
  the `io.cilium/lb-ipam-ips` annotation, **not** `spec.loadBalancerIP`. A
  MetalLB HelmRepository source and a live `metallb-system` namespace still
  exist; both are legacy and unused.
  Assigned VIPs: `.6` irc, `.7` k8s-gateway, `.8` lan-dns, `.9`
  wildcard-gregbob-net Gateway.
- **Ingress lives in `network/`**: `agentgateway` (the Gateway API
  implementation, Gateway `wildcard-gregbob-net`), `k8s-gateway` (DNS
  authority for the `gregbob.net` zone), `lan-dns` (CoreDNS LAN resolver).
  **There is no cloudflared / Cloudflare Tunnel any more** (removed
  2026-09-13). Public traffic reaches the cluster through a router
  port-forward of 80/443 to the gateway VIP `192.168.2.9`, with Cloudflare
  proxying in front (orange cloud, origin = the WAN IP).
- **HTTPRoute convention**: `parentRefs` names `wildcard-gregbob-net` in
  namespace `network` **by name only**, no `sectionName`. The Gateway's
  listeners allow routes from all namespaces.
- **Remote access** is a WireGuard VPN on the UDM, not an in-cluster
  component. NetBird was removed (2026-09-13); a `wireguard` namespace and a
  `wireguard` HelmRepository source survive as legacy with no manifests
  behind them.
- **TLS**: cert-manager with the `letsencrypt-prod` ClusterIssuer via
  Cloudflare DNS-01. One `Certificate`, `wildcard-gregbob-net` in `network`,
  covers `*.gregbob.net` and the apex.

## Validation

There is no CI build. Validate before pushing:

```sh
# Render a namespace root (catches YAML + reference errors)
kubectl kustomize clusters/cluster0/kubernetes/apps/<ns>

# Live state
kubectl get kustomizations -n flux-system
flux get sources all
```

Note: several `ai-system` Kustomizations (`kagent`, `substrate`,
`agent-sandbox` and their dependents) are persistently `False` on upstream
CRD-schema mismatches. That is pre-existing; do not treat it as breakage
caused by an unrelated change.
