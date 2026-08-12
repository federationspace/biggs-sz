# AGENTS.md: biggs-sz

Guidance for AI coding agents working in this repository.

## What this repo is

Flux CD GitOps repo for a single k3s homelab cluster (`cluster0`). All desired
cluster state lives here as YAML; Flux reconciles it. There is no app source
code here, only declarative infrastructure.

- `clusters/cluster0/flux-system/`: Flux itself (GitRepository sources).
- `clusters/cluster0/kubernetes/apps/<namespace>/`: applications grouped by
  namespace.
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

- `ks.yaml` sets `path: ./clusters/cluster0/kubernetes/apps/<ns>/<app>/app`
  and `commonMetadata.labels.app.kubernetes.io/name: <app>`.
- Multi-stage apps put several Kustomizations in one `ks.yaml` with
  `dependsOn` for ordering (see `cert-manager`: chart first, then issuers).
- The `<ns>/kustomization.yaml` lists each app's `ks.yaml`; add new apps there.

## Cluster specifics that bite

- The single k3s control plane runs on the NAS host (`control-01`) and also
  hosts media pods on purpose: downloads stage on local SSD, then move to the
  ZFS pool locally instead of over the 1Gbps network.
- Default StorageClass is k3s `local-path`. NFS (`provisioner: external-nfs`)
  backs shared media volumes.
- MetalLB provides L2 LoadBalancer IPs (`kind: IPAddressPool`).
- Media apps (jellyfin, ersatztv) pin to `worker-01`/`worker-02` for Intel
  iGPU hardware transcoding.
- Ingress lives in `network/`: agentgateway, cloudflared, k8s-gateway.

## Validation

There is no CI build. Validate before pushing:

```sh
# Render a kustomize root (catches YAML + reference errors)
kubectl kustomize clusters/cluster0/kubernetes/apps/<ns>

# Live state
kubectl get kustomizations -A
flux get sources all
```
