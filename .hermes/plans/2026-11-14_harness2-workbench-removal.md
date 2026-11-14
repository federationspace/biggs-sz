# Parking note: harness2 workbench removed from cluster0

Status: REMOVED 2026-11-14. The `hermes/harness2` workbench, its runbook
and the AGENTS.md entry are gone from `main`; this note is the record of
what it was, what was verified before the removal, and what the removal
frees. For a zero-context future reader: the manifests survive in git
history at the merge commit of this note.

## What was verified live before removal (2026-11-14, `origin/main` b9d8d9a)

| Fact | Value | How verified |
|---|---|---|
| Workbench pod | Running 1/1 on worker-00, `nousresearch/hermes-agent:v2026.9.24`, up ~4d | `kubectl -n hermes get pods` |
| PVC `harness2-data` | Bound, 10Gi ceph-block RWO, 16d old, 1.1G used | `kubectl -n hermes get pvc`; `du -sh /opt/data` in the pod |
| Long-term state | `library/` 80K (10 files: `INDEX.md` + entries `renovate-risk`, `smoke-test`, `smoke-test-demo`); `runs/` 2.7M; `candidates/` 184K. The rest of the 1.1G is ephemeral Hermes home (caches, probe profiles, gateway state) | `du -sh`, `find` in the pod as uid 10000 |
| Library export (merge gate) | `~/Downloads/harness2-workbench-20261114T144614Z.tar.gz` (312K), sha256 `60feaddae4548c0e99006d9e9e2a58dc1ce288e41886c9faa75ba1c994482290`, library file list matches the live volume 10/10 | `tar -czf` through `kubectl exec`, `gzip -t`, `tar -tzf` vs `find` |
| Flux state | Kustomization `harness2` Ready at `main@sha1:b9d8d9a...`; root and app `prune: true`, so merge prunes the workloads **and the PVC** | `kubectl get kustomization -n flux-system` |

## What it was

The harness2-hermes scaffold (github.com/shrinedogg/harness2-hermes, pinned
`0ec326d5`) running the Harness² Propose-Probe-Compose loop (arXiv:2610.14224)
on a dedicated Hermes home in a second pod of the `hermes` namespace.
Deployed 2026-10-28/29 (PR #289 workbench, #290 smoke CronJob, #291
runbook). It shared only the bot's `hermes-config` ConfigMap (`config.yaml`
key) and `NOUS_API_KEY` from `hermes-secrets`; it never carried the bot's
Matrix token or dashboard credentials by design, because the scaffold
copies `$HERMES_HOME/.env` into every probe profile and probes run
unattended with a terminal tool.

Result of the one real round (`renovate-risk`): banked KEEP_BASE /
NO_ENTRY with an operator note. Nothing was adopted into the bot.

## Findings worth keeping if this is ever revisited

- The free Beam model and `inception/mercury-2.5` both failed at the
  judgement stages, in different ways (Beam: unread or misread evidence;
  Mercury 2.5: off-dimension edit, and a byte-identity claim made without
  diffing). A short factual gate over the trajectories passed on both
  before the real stage failed on both, so the gate is necessary, not
  sufficient.
- Unattended stage sessions improvise. One editor ran `pip install`, wrote
  a file under a mistyped relative path, `rm -rf`ed it, and left a stray
  script at the checkout root. Check `git status --short` after every
  stage and expect changes only under `candidates/`, `runs/`, `library/`.
- Upstream bug at `0ec326d`: `smoke.sh` / `version-check.sh` read the
  version with `hermes --version | head -1` under `pipefail`; `head` closes
  the pipe, Hermes exits 1 on BrokenPipeError, and the marker file pins
  the wrong value (`hermes CLI missing`). The CronJob patched it to
  `sed -n 1p` in-job with a grep guard.
- A tree's top-level `scripts/` cannot override a skill script of the same
  name (`run_probe.sh` copies the tree's scripts first, then skill scripts
  over them).
- Deleting a probe profile leaves its s6 service slot registered (stopped);
  slots clear on the next pod restart.

## What the removal frees

- `harness2.gregbob.net` (wildcard Cloudflare zone; no DNS entry to clean).
- PVC `harness2-data`: 10Gi ceph-block; Flux prune deletes the RBD at merge.
- The workbench's 250m CPU / 768Mi requests from worker-00 (pod-level
  limits went up to 3Gi during probe runs).
- Port 9119 in the `hermes` namespace is the bot's own dashboard port and
  stays; no collision either way.
- No LoadBalancer/VIP was involved (ClusterIP only).

## Follow-ups the cluster cannot do

1. **Delete the 1Password item `harness2-dashboard`** (biggs-sz vault;
   fields `dashboard-user`, `dashboard-pass`, `dashboard-secret`). The
   ExternalSecret is pruned by Flux, but the item outlives it.
2. **Draft PR #335** (`hermes-catalog-harness2`, 2026-11-11) bundled this
   same workbench removal with a migration of the bot to a custom
   `catalog-harness2` image build with the harness2 plugin enabled in-bot.
   It was blocked on an image build (`shrinedogg/hermes-agent`, build
   branch handed over as `hermes-agent-build-branch.patch`, sha256
   `535490c8...`). This PR supersedes its removal half; if the in-bot
   plugin direction is still wanted, #335 needs rebasing onto this removal
   (its deletions of `apps/hermes/harness2/`, `kustomization.yaml`,
   `AGENTS.md` and the runbook now conflict). If not, close it.

## Restoring, if ever wanted

Re-add the app directory (seven files, all in git history) plus the
`- ./harness2/ks.yaml` line in `apps/hermes/kustomization.yaml`, recreate
the 1Password item, and merge. The init container re-clones the scaffold
from github at the pinned ref onto the fresh volume; to restore state,
copy the export tarball above back into the PVC (e.g. `kubectl cp` the
extracted `library/` into the seed pod before it starts, then restart).
The library tarball is the warm start; `runs/` and `candidates/` in it are
for reference only.
