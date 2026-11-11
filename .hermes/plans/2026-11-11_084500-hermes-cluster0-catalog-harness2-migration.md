---
title: Hermes cluster0 catalog-harness2 migration (plan)
tags:
  - kubernetes
  - cluster0
  - biggs-sz
  - hermes
  - harness2
  - flux
  - plan
---

# Hermes on cluster0 (biggs-sz): move to the catalog-harness2 build with the harness2 plugin on

> **For Hermes:** Use subagent-driven-development to implement this plan task by task. The operator owns every merge and every live `kubectl` / `flux` command. Agents land changes as branch + PR, or as a patch file where a token is refused.

**Goal:** Run the `hermes/hermes` Matrix bot in cluster0 on a fresh image built from `shrinedogg/hermes-agent@catalog-harness2`, with the harness2 plugin installed and enabled, and keep all user data that the current pod holds. Retire the old `hermes/harness2` workbench in the same change.

**Architecture:** Same Deployment, same PVC, new image. The data does not move: the new pod mounts the existing `hermes-data` volume and the new code migrates it forward at first boot. A full backup taken with the bot stopped is the way back. The plugin is baked into the image and copied onto the volume at first boot. It is switched on in the Git-managed ConfigMap, because an init container overwrites `config.yaml` and `SOUL.md` on every pod start.

**Tech stack:** Flux CD, Kubernetes (k3s), Rook-Ceph RBD (`ceph-block`), GitHub Actions, Docker Hub, Hermes Agent, harness2-hermes plugin.

**Status:** Plan only. Nothing here was pushed, built, merged, or applied. Written 2026-11-11 from a host with no access to cluster0. The decisions in section 2 were made by the operator on 2026-11-11.

---

## 0. Values to fill in (HOLD)

| Placeholder | What it is | Where it comes from |
| --- | --- | --- |
| `<BUILD_SHA7>` | First 7 characters of the build branch head commit | Step 2.5 (`git rev-parse --short=7 HEAD`) |
| `<DIGEST>` | `sha256:...` of the published image | Step 3.3 (workflow summary, checked against Docker Hub) |
| `<EXPORT_FILE>` | File name of the workbench export on the operator's machine | Step 6.1 |
| `<BACKUP_FILE>` | File name of the bot volume backup on the operator's machine | Step 7.4 |
| `<cluster1>` | kubectl context name for cluster1 on the operator's machine | The operator's kubeconfig |

Do not run a task that uses a placeholder until the task that produces it is done.

## 1. What I checked, and what I could not

### Verified today (read-only)

| Fact | Evidence |
| --- | --- |
| biggs-sz `main` is `d0e8c55` (2026-11-11, fetched again after the decisions). The bot is Deployment `hermes` in namespace `hermes`: image `docker.io/nousresearch/hermes-agent:v2026.9.24`, `args: ["gateway", "run"]`, strategy `Recreate`, PVC `hermes-data` (`ceph-block`, RWO, 10Gi) at `/opt/data`. | Anonymous clone, `clusters/cluster0/kubernetes/apps/hermes/hermes/app/deployment.yaml` |
| Init container `seed-config` overwrites `/opt/data/config.yaml`, `SOUL.md`, and `auth.json` on every pod start. | Same file, lines 88-133 |
| Tag `v2026.9.24` is upstream release `v0.21.5`. It already uses s6 and the same `gateway_state.json` logic. | `git fetch` of the tag, commit `f97608f` "chore: release v0.21.5 (2026.9.24)", `docker/s6-rc.d/`, `hermes_cli/container_boot.py` |
| `catalog-harness2` head is `2ddca67bce35e7352f49d98ab3545e34731e056c`. It differs from upstream `main` by one file, `plugin-catalog/harness2.yaml`. That file is a catalog entry (a pointer). The branch does not contain, install, or enable the plugin. | `git ls-remote`, GitHub compare API |
| `catalog-harness2` is the head of open upstream PR NousResearch/hermes-agent#149360. | GitHub pulls API |
| Branch `build/dockerhub-catalog-harness2` (head `76ee6126`) holds the build setup: the vendored plugin, a boot-hook block that copies it to `$HERMES_HOME/plugins/` when absent, and the Docker Hub workflow. It is 3 commits ahead of an old catalog head and 3799 behind the current one. | GitHub compare API, fetched branch |
| Those 3 commits cherry-pick onto `2ddca67` with no conflict. | Dry run in a scratch worktree, then removed. Nothing pushed. |
| Docker Hub `shrinedogg/hermes-agent` has one tag, `catalog-harness2-cdc83cc` (amd64 only, 2026-11-08). cluster1 runs it. | Docker Hub API, biggs.dog `clusters/cluster1/.../hermes/app/deployment.yaml` |
| The catalog pins the plugin at `51acf02`. At that commit `core.py` line 27 is a bare `import yaml`. The image's Python has ruamel.yaml and no PyYAML, so that copy cannot load. Plugin `main` (`61bbac10caa5d056bc7e2b020e6de6c6ff76c770`) adds the fallback. | `git show 51acf027:core.py`; `import yaml` fails in the cdc83cc image's venv; the plugin's own `scripts/check_yaml_fallback.py` at `61bbac1` prints `verdict=ok provider=ruamel-fallback roundtrip=ok` under that venv |
| The only green build ran on GitHub-hosted `ubuntu-latest`, at commit `cdc83cc0`, where the workflow said `runs-on: ubuntu-latest`. The next commit changed it to `runs-on: [hermes, ubuntu-latest]`. There are zero runs at that revision. | Actions API: run 42452094419 job labels `["ubuntu-latest"]`; 0 runs for head `76ee6126` |
| At `2ddca67`, `gateway run` as container args is handled: it starts the supervised s6 gateway slot and the main process becomes `sleep infinity`. There is one gateway, not two. With no args, the slot starts only when `gateway_state.json` on the volume says `running`. | `hermes_cli/gateway.py` `_maybe_redirect_run_to_s6_supervision`; `docker/main-wrapper.sh`; `docker/s6-rc.d/main-hermes/run`; `hermes_cli/container_boot.py` `reconcile_profile_gateways` |
| The Matrix E2EE store path is the same in both versions: `platforms/matrix/store/crypto.db`. | `plugins/platforms/matrix/adapter.py` at both commits |
| A `plugins.enabled` list does not switch off the bundled Matrix adapter. | cluster1 install: `plugins.enabled` is `[harness2, platforms/a2a]` and Matrix is connected; `hermes_cli/plugins_discovery.py` "bundled auto-loads" |
| The plugin ships five skills: run, propose, compose, select, reflect. `harness2-ops` is not one of them. It is a profile skill on the cluster1 install. | `git ls-tree 61bbac1 skills/`, `/opt/data/skills/harness2-ops/` |
| In the new image, `hermes` on PATH is a shim that drops root to the `hermes` user. | `Dockerfile` at `2ddca67`: `docker/hermes-exec-shim.sh` copied to `/opt/hermes/bin/hermes`, first on `PATH` |
| `ceph-block` allows volume expansion and has reclaim policy `Delete`. | `rook-ceph/rook-ceph/cluster/helmrelease.yaml` lines 182-185 |
| Removing the `harness2` Flux Kustomization from Git deletes everything it applied, its PVC included. The root sync Kustomization has `prune: true`, so it deletes the `harness2` Kustomization object. That object has `prune: true`, and Flux then removes all objects it applied. | flux-operator `internal/builder/templates.go` (main branch); Flux `docs/spec/v1/kustomizations.md`: "Garbage collection is also performed when a Kustomization object is deleted"; `harness2/ks.yaml` line 20 |
| Nothing else in the repo depends on the workbench. The only references outside its own directory are `apps/hermes/kustomization.yaml` line 9, `AGENTS.md` lines 131-135, and `docs/runbooks/harness2.md`. | `grep -rn harness2` over the clone |
| The repo declares no VolumeSnapshotClass. | `rook-ceph/rook-ceph/cluster/helmrelease.yaml` lines 199-203 (commented out) |
| The manifest edits in Task 5 render. With the workbench directory removed, its line dropped from `kustomization.yaml`, the PVC at 20Gi, a placeholder image, revision "4", and the `plugins` block, `kubectl kustomize clusters/cluster0/kubernetes/apps/hermes` succeeds, and the embedded `config.yaml` parses with `plugins: {enabled: [harness2]}`. | Dry run in the scratch clone, then reset. Nothing pushed. |

### Not verified (no cluster access from this host)

- Anything live in cluster0: pod state, what is on the PVC and how full it is, node architecture, the Flux revision, whether Renovate has already moved the image tag.
- Whether the fork's `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets are still valid. Last known good: 2026-11-08.
- The `prune` setting of the root Kustomization as deployed. I read the operator's current template, not the live object. Step 4.5 checks it.
- I cannot push to `federationspace/biggs-sz`: the org rejects my fine-grained token (HTTP 403, token lifetime over 366 days). By decision, I hand over a patch file (Task 5).

## 2. Decisions (operator, 2026-11-11)

| # | Decision | Answer | What it means for the plan |
| --- | --- | --- | --- |
| D1 | Image | New build from the current `catalog-harness2` head | Tasks 2 and 3 |
| D2 | Build runner | `ubuntu-latest` | Step 2.3 |
| D3 | Build branch | New branch `build/dockerhub-catalog-harness2-2ddca67`, three build commits cherry-picked | Step 2.1. No force-push. `catalog-harness2` is not touched. |
| D4 | Plugin version | `61bbac1` on the build branch only | Step 2.2. The pin on the upstream PR branch stays at `51acf02`. |
| D5 | Container args | Keep `args: ["gateway", "run"]` | No change to that line |
| D6 | Default mode | Plugin on now. The default-mode text comes later, after the bot has a stronger model. | `SOUL.md` is not changed in this PR. See follow-up 1 and Appendix A. |
| D7 | Old workbench | Retire it in the same PR, after exporting its library | Task 6 (export), Step 5.4 (removal) |
| D7b | Workbench volume | Let Flux delete `harness2-data` with the app. The export is the only copy. | Task 6 is a gate before the merge |
| D8 | Bot volume | Grow `hermes-data` to 20Gi in this PR | Step 5.1. Step 4.3 is a gate. A volume cannot shrink, see Task 10. |
| PR | Who opens the biggs-sz PR | The agent prepares a patch file. The operator applies it, pushes, and opens the PR. | Task 5 |

One trade-off stays, and you accepted it by choosing to run the plugin in the bot:

- **Isolation.** The workbench was built so that unattended probes never see the bot's Matrix token. From now on, a harness2 probe runs inside the bot's pod. The `61bbac1` plugin strips platform credentials from the probe profile's `.env`. The secrets here come in as container environment variables, so a probe's terminal tool can still read them. This is the same trade as on cluster1.

Because of D6, a loop runs only when someone asks the bot for one. The plugin is installed and enabled, but it is not yet the default way of working.

---

## Task 1: Preflight on the fork (operator, no cluster needed)

**Objective:** Confirm the starting state has not moved.

**Step 1.1**

```sh
git ls-remote https://github.com/shrinedogg/hermes-agent refs/heads/catalog-harness2 refs/heads/build/dockerhub-catalog-harness2
git ls-remote https://github.com/shrinedogg/harness2-hermes refs/heads/main
```

Expected: `2ddca67bce35e7352f49d98ab3545e34731e056c`, `76ee6126b6b226fab44856ae39fd912376fb5dd1`, `61bbac10caa5d056bc7e2b020e6de6c6ff76c770`.
If `catalog-harness2` moved: use the new head in Task 2 and in the branch name. If the plugin moved: stay on `61bbac1`; that is the decided version.

**Step 1.2** In GitHub, `shrinedogg/hermes-agent`, Settings, Secrets and variables, Actions: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` exist. If the Docker Hub token has an expiry, reissue it first.

## Task 2: Build branch (operator, or an agent with push access to the fork)

**Objective:** A new branch that holds the current catalog tree, the build setup, and a plugin that loads.

**Files:**
- Create: `plugins-vendor/harness2/**` (replaced with the `61bbac1` tree)
- Modify: `docker/stage2-hook.sh` (by cherry-pick), `plugin-catalog/harness2.yaml`, `.github/workflows/dockerhub-custom-build.yml`

**Step 2.1: Branch and cherry-pick** (dry-run verified, no conflicts)

```sh
git clone --filter=blob:none https://github.com/shrinedogg/hermes-agent && cd hermes-agent
git switch -c build/dockerhub-catalog-harness2-2ddca67 2ddca67bce35e7352f49d98ab3545e34731e056c
git cherry-pick e7f73467ef81753fbcec975503a49571ddec28d4 \
                cdc83cc02fb517f731ee24a38ca4fb0860392703 \
                76ee6126b6b226fab44856ae39fd912376fb5dd1
git log --oneline -4
```

Expected: three new commits on top of `2ddca67`.

**Step 2.2: Vendor the plugin at 61bbac1** (not run here)

```sh
git rm -r -q plugins-vendor/harness2
git clone -q https://github.com/shrinedogg/harness2-hermes ../h2h-vendor
mkdir -p plugins-vendor/harness2
git -C ../h2h-vendor archive 61bbac10caa5d056bc7e2b020e6de6c6ff76c770 | tar -x -C plugins-vendor/harness2
perl -pi -e 's/51acf027903332ca52516f602a2c47fd348dc0cb/61bbac10caa5d056bc7e2b020e6de6c6ff76c770/g' plugin-catalog/harness2.yaml
```

The catalog file is changed on the build branch only, so the image's catalog entry and its vendored copy agree. The upstream PR branch keeps its pin (D4).

**Step 2.3: Use the proven runner** (not run here)

```sh
perl -pi -e 's/runs-on: \[hermes, ubuntu-latest\]/runs-on: ubuntu-latest/' .github/workflows/dockerhub-custom-build.yml
grep -n 'runs-on' .github/workflows/dockerhub-custom-build.yml
```

Expected: two lines, both `runs-on: ubuntu-latest`. Also fix the comment above the first one so it no longer claims a fallback. A `runs-on` list needs one runner that has every label; it is not a fallback list.

**Step 2.4: Check**

```sh
grep -n 'ruamel' plugins-vendor/harness2/core.py | head -3     # expect the fallback import lines
ls plugins-vendor/harness2/scripts/check_yaml_fallback.py      # expect the file
grep -rn '51acf02' plugins-vendor plugin-catalog/harness2.yaml  # expect no output
python3 scripts/ci/check_profile_archive_boundary.py           # expect exit 0
```

**Step 2.5: Commit and push the new branch**

```sh
git add -A
git commit -m "build: vendor harness2 @ 61bbac1, build on ubuntu-latest"
git rev-parse --short=7 HEAD        # this is <BUILD_SHA7>
git push -u origin build/dockerhub-catalog-harness2-2ddca67
```

This is a new ref. No force-push. Do not push anything to `catalog-harness2`.

## Task 3: Build and publish (operator)

**Objective:** One immutable image tag and its digest.

**Step 3.1: Dispatch.** The workflow only runs on manual dispatch. A dispatch on a non-default branch worked before (run 42452094419).

```sh
gh workflow run dockerhub-custom-build.yml --repo shrinedogg/hermes-agent \
  --ref build/dockerhub-catalog-harness2-2ddca67
gh run watch --repo shrinedogg/hermes-agent \
  "$(gh run list --repo shrinedogg/hermes-agent --workflow dockerhub-custom-build.yml -L1 --json databaseId -q '.[0].databaseId')"
```

Expected: both jobs green. The build job has a 90 minute limit. The tag defaults to `catalog-harness2-<BUILD_SHA7>`.
If the login step fails with 401: reissue `DOCKERHUB_TOKEN` and dispatch again.

**Step 3.2: Read the digest** from the run summary, block "Cutover pin".

**Step 3.3: Cross-check**

```sh
curl -s "https://hub.docker.com/v2/repositories/shrinedogg/hermes-agent/tags/catalog-harness2-<BUILD_SHA7>" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["digest"], [i["architecture"] for i in d["images"]])'
```

Expected: the same `sha256:...` and `['amd64']`. This is `<DIGEST>`.

**Step 3.4: Prove the plugin loads in the image** (needs Docker; add `--platform linux/amd64` on an Apple Silicon Mac)

```sh
docker run --rm --entrypoint /opt/hermes/.venv/bin/python \
  docker.io/shrinedogg/hermes-agent:catalog-harness2-<BUILD_SHA7>@<DIGEST> \
  /opt/hermes/plugins-vendor/harness2/scripts/check_yaml_fallback.py
```

Expected: `verdict=ok provider=ruamel-fallback roundtrip=ok`. Any other output: stop, the vendor step went wrong.

## Task 4: Preflight on cluster0 (operator)

**Objective:** Know the live state before touching it. All read-only.

**Step 4.1**

```sh
kubectl -n hermes get deploy hermes -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl -n hermes get deploy,pod,pvc,cronjob -o wide
kubectl -n hermes get externalsecret hermes-secrets
flux get kustomization hermes -n flux-system
```

Expected: image `docker.io/nousresearch/hermes-agent:v2026.9.24`; the `hermes` and `harness2` pods Running; PVCs `hermes-data` and `harness2-data` Bound; ExternalSecret Ready; Kustomization Ready.
If the image tag is different, Renovate moved it: tell the agent, so the patch in Task 5 is made against that. If anything is unhealthy: fix that first.

**Step 4.2**

```sh
kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
```

Expected: every node `amd64`. The new image is amd64 only. If a node is arm64, tell the agent: the patch then adds a required node affinity `kubernetes.io/arch In [amd64]`.

**Step 4.3 (gate for the 20Gi change)**

```sh
kubectl get sc ceph-block -o jsonpath='{.allowVolumeExpansion}{"\n"}'
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph df 2>/dev/null | head -12
```

Expected: `true`. If it is not `true`, stop: Flux would fail to apply the larger PVC, and with it the whole `hermes` Kustomization. The second command checks free space in the pool and works only if the Rook toolbox is deployed; skip it otherwise.

**Step 4.4**

```sh
kubectl -n hermes exec deploy/hermes -c hermes -- sh -c 'df -h /opt/data; ls -A /opt/data; du -sh /opt/data/* 2>/dev/null | sort -h | tail -15'
kubectl -n hermes exec deploy/hermes -c hermes -- sh -c 'cat /opt/data/gateway_state.json 2>/dev/null || echo ABSENT; ls /opt/data/plugins /opt/data/platforms/matrix/store 2>&1'
```

Save the output. It is the baseline for Task 9. No action for any value. Expect `crypto.db` in the Matrix store if the bot has used encrypted rooms.

**Step 4.5 (gate for the workbench removal)**

```sh
kubectl -n flux-system get kustomization flux-system -o jsonpath='{.spec.prune}{"\n"}'
kubectl -n flux-system get kustomization harness2 -o jsonpath='{.spec.prune} {.spec.deletionPolicy}{"\n"}'
```

Expected: `true`, then `true` followed by nothing or `MirrorPrune`. This means the merge deletes the workbench and its volume. If the first value is `false`, the workbench stays after the merge; delete it by hand then with `kubectl -n flux-system delete kustomization harness2`.

**Step 4.6** Pick one fact the bot knows only from an old session or memory. You will ask for it in Task 9.

## Task 5: The biggs-sz change, as a patch file

**Objective:** One PR, opened by the operator from a patch the agent prepares. Branch name: `hermes-catalog-harness2`. Base: current `main`. The agent needs `<BUILD_SHA7>` and `<DIGEST>` first; it reads them from Docker Hub once the build is done.

**Files:**
- Modify: `clusters/cluster0/kubernetes/apps/hermes/hermes/app/deployment.yaml`
- Modify: `clusters/cluster0/kubernetes/apps/hermes/hermes/app/configmap.yaml`
- Modify: `clusters/cluster0/kubernetes/apps/hermes/kustomization.yaml`
- Delete: `clusters/cluster0/kubernetes/apps/hermes/harness2/` (7 files)
- Modify: `renovate.json`, `AGENTS.md`
- Rewrite: `docs/runbooks/harness2.md`
- Create: `.hermes/plans/2026-11-11_084500-hermes-cluster0-catalog-harness2-migration.md` (this file; the repo keeps plans there)

### 5.1 deployment.yaml: three lines

PVC `hermes-data`:

```yaml
      storage: 20Gi
```

Pod annotation:

```yaml
        hermes.gregbob.net/config-revision: "4"
```

Container `hermes`:

```yaml
          # Custom build of github.com/shrinedogg/hermes-agent, branch
          # build/dockerhub-catalog-harness2-2ddca67 (= catalog-harness2 @ 2ddca67
          # + the harness2 plugin vendored @ shrinedogg/harness2-hermes 61bbac1).
          # The image copies the plugin to /opt/data/plugins/harness2 at first
          # boot, only when absent. amd64 only. Digest from the build run.
          # Excluded from Renovate; rebuild and re-pin by hand.
          image: docker.io/shrinedogg/hermes-agent:catalog-harness2-<BUILD_SHA7>@<DIGEST>
```

Everything else stays, including `args: ["gateway", "run"]`, the `seed-config` init container, env, `envFrom`, probes, resources, and `fsGroup`. The new image's boot hook seeds `config.yaml`, `SOUL.md`, and `.env` only when the file is missing, so it does not fight the init container.

### 5.2 configmap.yaml: switch the plugin on

Add at the end of the `config.yaml` key, after the `auxiliary.vision` block. The 4-space indent is part of it. The `SOUL.md` key is not changed (D6).

```yaml
    # harness2 plugin. The custom image seeds it into /opt/data/plugins/harness2
    # at first boot (only when absent). This allow-list turns it on. It must
    # live here: seed-config overwrites /opt/data/config.yaml on every boot.
    # plugins.disabled, if ever added, wins over this list.
    plugins:
      enabled:
        - harness2
```

### 5.3 renovate.json: keep Renovate off the custom image

Add to `packageRules`:

```json
{
  "description": "Custom catalog-harness2 build of hermes-agent: built by hand on the fork and pinned by digest. Renovate must not propose bumps.",
  "matchDatasources": ["docker"],
  "matchPackageNames": ["/(^|/)shrinedogg/hermes-agent$/"],
  "enabled": false
}
```

### 5.4 Retire the workbench

- In `clusters/cluster0/kubernetes/apps/hermes/kustomization.yaml`, remove the line `  - ./harness2/ks.yaml`.
- Delete the directory `clusters/cluster0/kubernetes/apps/hermes/harness2/`.

After the merge, Flux removes Deployment `harness2`, CronJob `harness2-smoke`, Service `harness2`, HTTPRoute `harness2` (`harness2.gregbob.net`), ExternalSecret `harness2-dashboard`, ConfigMap `harness2-config`, ServiceAccount `harness2`, and PVC `harness2-data` with its data (D7b). The namespace and the bot are not touched.

### 5.5 AGENTS.md: replace the Hermes bullet (lines 131-135)

```markdown
- **Hermes**: `hermes/hermes` is the Matrix bot (dashboard at
  `hermes.gregbob.net`). It runs a custom build of the
  `shrinedogg/hermes-agent` fork (branch `catalog-harness2`), pinned by
  digest and excluded from Renovate: rebuild and re-pin by hand. The image
  ships the harness2 plugin and seeds it into `/opt/data/plugins/harness2`
  when that directory is absent; `plugins.enabled` in `hermes-config` turns
  it on. harness2 probes run inside the bot's pod and can read its
  environment. The separate Harness² workbench was retired. See
  `docs/runbooks/harness2.md`.
```

### 5.6 docs/runbooks/harness2.md: new content

````markdown
# Runbook: harness2 plugin on the Hermes bot (`hermes/hermes`)

The [harness2-hermes](https://github.com/shrinedogg/harness2-hermes) loop
(Harness², arXiv:2610.14224) runs as a plugin inside the Matrix bot. The
separate workbench (`hermes/harness2`) was retired; see History.

## What runs where

| Thing | Where |
| --- | --- |
| Plugin code | `/opt/data/plugins/harness2` on PVC `hermes-data`. The image carries a copy at `/opt/hermes/plugins-vendor/harness2` and copies it to the volume at boot only when the directory is absent. |
| Switch | `plugins.enabled: [harness2]` in the `config.yaml` key of ConfigMap `hermes-config`. Change it in Git: the `seed-config` init container overwrites the volume's `config.yaml` on every pod start. |
| State | `/opt/data/plugin-data/harness2/` (`runs/`, `candidates/`, `library/`). It lives on the PVC only. |
| Probe profiles | `/opt/data/profiles/harness2-<task>-<probe>`. One per probe. Remove them with the `harness2_gc` tool after a round. |

The plugin adds these tools: `harness2_init`, `harness2_probe`,
`harness2_seed`, `harness2_check`, `harness2_adopt`, `harness2_promote`,
`harness2_library`, `harness2_status`, `harness2_gc`.

## Running a round

Ask the bot (dashboard chat or Matrix) to run a harness2 loop for a task. It
is not the default way of working: nothing in `SOUL.md` tells the bot to use
it on its own.

- A round is four or more agent sessions. Each probe has a wall-clock budget
  (plugin setting `probe_budget_seconds`, default 900).
- Probes run in the bot's pod, as the `hermes` user, on the bot's volume,
  with the bot's model and its full tool access. They can read the pod's
  environment, which holds the Matrix token and the dashboard login.
- The bot's free model was weak at the judgement stages of the loop when the
  workbench used it (see History). Check what a round banked before trusting it.

## Getting a shell

```sh
kubectl -n hermes exec -it deploy/hermes -c hermes -- su hermes -s /bin/bash
```

Work as the `hermes` user. Files created as root break later runs. The
`hermes` command on PATH drops root by itself.

## Upgrading

- **Image.** On the fork, make a new build branch from the new
  `catalog-harness2` head, cherry-pick the build commits, dispatch
  "Docker Build and Publish (Docker Hub, shrinedogg)", and put the new tag and
  digest on the image line in `hermes/app/deployment.yaml`. Renovate does not
  track this image.
- **Plugin.** A new image does not replace the copy on the volume. To take the
  image's copy, remove the directory and restart the pod:
  `kubectl -n hermes exec deploy/hermes -c hermes -- rm -rf /opt/data/plugins/harness2`
  then `kubectl -n hermes rollout restart deploy/hermes`. The state under
  `plugin-data/` is kept. (This follows from the image's boot hook. It has not
  been exercised on this cluster yet.)

## History

- 2026-10-28: workbench (#289) and smoke CronJob (#290) deployed.
- 2026-10-29: first workbench round, `renovate-risk`. Banked KEEP_BASE /
  NO_ENTRY with an operator note. The free model skipped, then misread, the
  rollouts at the composer stage; a re-run on `inception/mercury-2.5` produced
  only an inert edit.
- 2026-11: the bot moved to the `catalog-harness2` custom build with the
  plugin enabled. The workbench, its smoke CronJob, and its volume
  `harness2-data` were removed. Its library was exported first.
````

### 5.7 How the patch is made and checked (agent)

```sh
git clone https://github.com/federationspace/biggs-sz && cd biggs-sz
# apply the edits from 5.1 to 5.6 and copy this plan to .hermes/plans/
git add -A
git diff --cached --binary > ../hermes-catalog-harness2.patch
kubectl kustomize clusters/cluster0/kubernetes/apps/hermes >/dev/null && echo render-ok
python3 -c 'import json; json.load(open("renovate.json")); print("json-ok")'
grep -c 'image: docker.io/shrinedogg/hermes-agent:catalog-harness2-.*@sha256:[0-9a-f]\{64\}$' \
  clusters/cluster0/kubernetes/apps/hermes/hermes/app/deployment.yaml
# then, in a second fresh clone:
git apply --check ../hermes-catalog-harness2.patch && echo applies-clean
```

Expected: `render-ok`, `json-ok`, `1`, `applies-clean`. The manifest part of this was dry-run today with a placeholder image and rendered. The patch itself does not exist yet.

The agent saves the patch on its own host at `/opt/data/.hermes/plans/hermes-catalog-harness2.patch` and reports its SHA-256.

### 5.8 Apply, push, open the PR (operator; not run here)

```sh
kubectl --context <cluster1> -n hermes exec deploy/hermes -c gateway -- \
  cat /opt/data/.hermes/plans/hermes-catalog-harness2.patch > hermes-catalog-harness2.patch
shasum -a 256 hermes-catalog-harness2.patch        # compare with the value the agent reported
git clone https://github.com/federationspace/biggs-sz && cd biggs-sz
git switch -c hermes-catalog-harness2
git apply --index ../hermes-catalog-harness2.patch
git status --short && git diff --cached --stat
git commit -m "feat(hermes): move the bot to the catalog-harness2 build, enable harness2, retire the workbench"
git push -u origin hermes-catalog-harness2
gh pr create --repo federationspace/biggs-sz --base main --head hermes-catalog-harness2 --fill
```

Put the image tag, the digest, and the Actions run URL in the PR body. Do not merge yet.

## Task 6: Export the workbench library (operator)

**Objective:** The only copy of the workbench's state, on your machine, before the merge deletes its volume. The bot stays up during this task.

**Step 6.1**

```sh
EXPORT_FILE=harness2-workbench-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
kubectl -n hermes exec deploy/harness2 -c harness2 -- sh -c \
  'cd /opt/data/harness2-hermes && tar -czf - $(ls -d library runs candidates 2>/dev/null)' > "$EXPORT_FILE"
```

`library/` is the long-term state (path from the repo's runbook). `runs/` and `candidates/` are included because the volume is deleted and they cost little. Not run here.

**Step 6.2: Verify (gate)**

```sh
gzip -t "$EXPORT_FILE" && tar -tzf "$EXPORT_FILE" | grep -c '^library/' && shasum -a 256 "$EXPORT_FILE"
tar -tzf "$EXPORT_FILE" | grep '^library/' | head
kubectl -n hermes exec deploy/harness2 -c harness2 -- sh -c 'find /opt/data/harness2-hermes/library -type f | wc -l'
```

Expected: `gzip -t` is silent, and the count of `library/` entries in the archive is at least the file count from the pod (the archive also lists directories). If the archive has no `library/` entries, stop and do not merge. Add the file name and its SHA-256 to the PR body.

## Task 7: Back up the bot's volume with the bot stopped (operator)

**Objective:** A consistent copy of the whole volume on your machine. The bot is offline from Step 7.2 until Task 8 ends. Do this only when the PR is reviewed and Task 6 is done.

A copy taken while the gateway runs can catch the SQLite files mid-write. Stopping the pod first avoids that. Flux must be paused, or it scales the Deployment back up.

**Step 7.1**

```sh
flux suspend kustomization hermes -n flux-system
```

**Step 7.2**

```sh
kubectl -n hermes scale deploy/hermes --replicas=0
kubectl -n hermes wait --for=delete pod -l app.kubernetes.io/name=hermes --timeout=180s
```

**Step 7.3: Helper pod.** It must stay running: `kubectl exec` does not work on a finished pod.

```sh
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: hermes-data-helper
  namespace: hermes
  labels:
    app.kubernetes.io/name: hermes-data-helper
spec:
  restartPolicy: Never
  containers:
    - name: helper
      image: docker.io/library/busybox:1.38
      command: ["sleep", "7200"]
      volumeMounts:
        - name: data
          mountPath: /opt/data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: hermes-data
EOF
kubectl -n hermes wait --for=condition=Ready pod/hermes-data-helper --timeout=180s
```

**Step 7.4: Stream the archive out**

```sh
BACKUP_FILE=hermes-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
kubectl -n hermes exec hermes-data-helper -- tar -czf - -C /opt/data . > "$BACKUP_FILE"
gzip -t "$BACKUP_FILE" && tar -tzf "$BACKUP_FILE" | wc -l && ls -lh "$BACKUP_FILE" && shasum -a 256 "$BACKUP_FILE"
tar -tzf "$BACKUP_FILE" | grep -E '^\./(memories|sessions|skills|cron|platforms)/' | head
kubectl -n hermes get deploy hermes -o jsonpath='{.spec.replicas}{"\n"}'
```

Expected: `gzip -t` is silent, the file count is not small, the listing shows the folders from Step 4.4, and the last line is `0` (the bot did not come back during the copy). A warning about a socket file is harmless. If the last line is not `0`, repeat from Step 7.1. Add the file name and its SHA-256 to the PR body. Keep the file for at least two weeks.

**Step 7.5: Remove the helper.** The new pod must not share the volume with it.

```sh
kubectl -n hermes delete pod hermes-data-helper --wait=true
```

## Task 8: Cutover (operator)

**Objective:** New pod on the same volume, workbench gone. Order: Tasks 6 and 7 done, helper pod gone, then merge.

**Two points of no return, both at the merge:**
- The workbench volume `harness2-data` is deleted. Only `<EXPORT_FILE>` remains.
- The first boot of the new image migrates `config.yaml` and the SQLite files on `hermes-data` forward. Going back to the old image does not undo that. After this point, rollback means restore first (Task 10).

**Step 8.1** Merge the PR to `main`.

**Step 8.2**

```sh
flux reconcile kustomization flux-system -n flux-system --with-source
flux resume kustomization hermes -n flux-system
kubectl -n hermes rollout status deploy/hermes --timeout=15m
```

Expected: rollout complete. The first pull of this image is several GB. The Kustomization has a 5 minute timeout, so it can show a failed health check once and then pass on retry. That is not an error.

## Task 9: Verify (operator)

**Objective:** Prove the bot works for a user, not only that a pod is Ready.

| # | Check | Command | Expected | If not |
| --- | --- | --- | --- | --- |
| 9.1 | Image | `kubectl -n hermes get pod -l app.kubernetes.io/name=hermes -o jsonpath='{.items[0].spec.containers[0].image}'` | The pinned `...@<DIGEST>` | Check the Flux revision |
| 9.2 | Boot log | `kubectl -n hermes logs deploy/hermes -c hermes \| grep -E 'stage2\|supervision'` | `Seeded vendored plugin harness2 into /opt/data/plugins/`, `Setup complete; starting user services`, `gateway is now running under s6 supervision`. No `docker_config_migrate.py failed`. | Read the full log before going on |
| 9.3 | One gateway, running | `kubectl -n hermes exec deploy/hermes -c hermes -- sh -c 'cat /opt/data/gateway_state.json'` | `"gateway_state": "running"` and Matrix listed as connected | `kubectl -n hermes logs deploy/hermes -c hermes --tail=200` |
| 9.4 | Plugin code loads | `kubectl -n hermes exec deploy/hermes -c hermes -- /opt/hermes/.venv/bin/python /opt/data/plugins/harness2/scripts/check_yaml_fallback.py` | `verdict=ok provider=ruamel-fallback roundtrip=ok` | The volume has an old plugin copy. Compare with the image's `/opt/hermes/plugins-vendor/harness2`. |
| 9.5 | Plugin enabled | `kubectl -n hermes exec deploy/hermes -c hermes -- hermes plugins list` | `harness2` shown as enabled | Check the `plugins:` block reached `/opt/data/config.yaml` |
| 9.6 | Data is there, volume is larger | Repeat Step 4.4, then `kubectl -n hermes get pvc hermes-data` | Same folders and sizes as the baseline, plus `plugins/`. `df` shows about 20G. PVC capacity `20Gi`. | Data missing: stop and go to Task 10. PVC still 10Gi: `kubectl -n hermes describe pvc hermes-data` and read the resize events. |
| 9.7 | The bot answers | Mention the bot in the Matrix home room with a plain question. Ask for the fact from Step 4.6. Post in an encrypted room. Open `https://hermes.gregbob.net`. | It answers, it knows the old fact, it reads the encrypted room, the dashboard logs in | Encrypted room unreadable: check `platforms/matrix/store` survived. No model reply: look for `No LLM provider configured` in the log. |
| 9.8 | Workbench is gone | `kubectl -n hermes get deploy,cronjob,pvc,httproute,externalsecret` and `kubectl -n flux-system get kustomization harness2` | Only `hermes` objects and `hermes-data`. The second command says NotFound. Give it a few minutes; Flux deletes in the background. | See Step 4.5 |
| 9.9 | The plugin does a real step | In the dashboard chat: "Use harness2_init to open a run named smoke-test for the task: write the word OK to ok.txt. Run one base probe with harness2_probe and tell me the result. Then clean up with harness2_gc for that task, with drop_runs." | The tools are called, a probe profile `harness2-smoke-test-*` appears under `/opt/data/profiles/` and is removed again, `/opt/data/plugin-data/harness2/` exists | Tool missing: back to 9.5. The model fumbles the tool calls: that is the free model; repeat once with shorter wording. |

## Task 10: Rollback (operator; not run here)

Two things cannot be undone: the workbench volume is gone, and `hermes-data` stays at 20Gi (a volume cannot shrink, and Flux would fail to apply a smaller size). So do **not** revert the whole PR. The rollback PR changes three things only, in `clusters/cluster0/kubernetes/apps/hermes/hermes/app/`:

- `deployment.yaml`: image line back to `docker.io/nousresearch/hermes-agent:v2026.9.24`, and remove the comment above it.
- `deployment.yaml`: `hermes.gregbob.net/config-revision: "5"`.
- `configmap.yaml`: remove the `plugins:` block.

**Before the first boot of the new image** (for example the image cannot be pulled): merge the rollback PR, then `flux reconcile kustomization flux-system -n flux-system --with-source`. The data was not touched.

**After the first boot:** restore, then roll back.

```sh
flux suspend kustomization hermes -n flux-system
kubectl -n hermes scale deploy/hermes --replicas=0
kubectl -n hermes wait --for=delete pod -l app.kubernetes.io/name=hermes --timeout=180s
# start the helper pod again: the manifest from Step 7.3
shasum -a 256 <BACKUP_FILE>          # must match the value in the PR body
kubectl -n hermes exec -i hermes-data-helper -- sh -c \
  'find /opt/data -mindepth 1 -maxdepth 1 ! -name lost+found -exec rm -rf {} + && tar -xzf - -C /opt/data' < <BACKUP_FILE>
kubectl -n hermes exec hermes-data-helper -- ls -A /opt/data
kubectl -n hermes delete pod hermes-data-helper --wait=true
# merge the rollback PR on main, then:
flux reconcile kustomization flux-system -n flux-system --with-source
flux resume kustomization hermes -n flux-system
kubectl -n hermes rollout status deploy/hermes --timeout=15m
```

Then repeat check 9.7. The `find ... rm -rf` line wipes the volume, so check the SHA-256 first.

To bring the workbench back, restore its directory from Git history in a separate PR. It starts empty; put `<EXPORT_FILE>` back by hand if you need the old state.

## Task 11: Follow-ups (separate PRs)

1. **Default mode (D6).** After the bot has a stronger model: append the text in Appendix A to the `SOUL.md` key of `hermes-config`, bump `config-revision`, and copy the `harness2-ops` skill from the cluster1 install to `/opt/data/skills/` on the bot's volume. The text names that skill and the plugin does not ship it. The text then applies to every Matrix user on the allow-list.
2. **Model.** Decide which model the bot gets.
3. **Plugin pin on the upstream PR.** `plugin-catalog/harness2.yaml` on `catalog-harness2` (PR #149360) still pins `51acf02`, which cannot load in the image. Left alone by decision D4.
4. **Next image bump.** Same path: new build branch from the new catalog head, cherry-pick, dispatch, new digest, one-line PR.
5. **Disk.** Watch `/opt/data/plugin-data/harness2`. Finished runs can be removed with `harness2_gc` and `drop_runs`.
6. **1Password.** Delete the item `harness2-dashboard`. Nothing reads it after the merge.

## Risks

| Risk | How the plan handles it |
| --- | --- |
| Pod Ready, bot silent | Args kept. Checks 9.3 and 9.7. |
| Plugin enabled but cannot load | Vendored at `61bbac1`. Checked before cutover (3.4) and after (9.4). |
| Build job waits forever for a runner | `ubuntu-latest`. |
| Bot data damaged by the forward migration | Stopped-pod backup (Task 7), restore steps (Task 10). |
| Backup taken from a live database | Flux paused and pod at zero before the copy; replica count checked after it. |
| Workbench state lost | Export verified before the merge (Task 6). After the merge there is no other copy. |
| Larger PVC rejected, so nothing in the `hermes` Kustomization applies | Gate in Step 4.3. |
| A plain revert fails on the PVC size | Task 10 names the three lines to change instead. |
| Probes can read the bot's secrets | Stated in section 2. Same as cluster1. Accepted. |
| Renovate noise on the custom image | Rule in 5.3. |

## Open points

1. Who runs Task 2 and the dispatch in Task 3: the operator, or the agent? A token write to this fork was checked on 2026-11-07 (commit `23adb8ac1` on `catalog-harness2`). Whether the agent's token may dispatch workflows is not verified.
2. Which model the bot gets, and when (follow-ups 1 and 2).

## Appendix A: default-mode text for the later PR (D6)

Source: `/opt/data/SOUL.md` lines 40-51 on the cluster1 Hermes pod, read 2026-11-11, copied word for word. Copy it again from the live file when the follow-up is made, in case it changed. It is indented 4 spaces for the `SOUL.md` block scalar in `configmap.yaml`.

```yaml
    # Default interaction mode: harness2

    The user opted in: in every chat on this profile, harness2 is the default mode of interaction.

    - At the start of a session, load the `harness2-ops` skill and consult the improvement library (`harness2_library action=list`) before handling a substantive request.
    - When the request is an actionable task (it produces an artifact or executes a workflow), ALWAYS run the harness2 loop — no exceptions, no operator discretion (standing user instruction 2026-11-06):
      - If the task class has a library entry, work under that banked harness. Do not re-run the loop unless the task has materially changed from the entry.
      - If it is new or materially changed, run the full loop: `harness2_init` with the request verbatim (no rubrics, answer keys, or scores), drive the stages to Adopt, deliver the promote report, and clean up with `harness2_gc`.
      - "Always" holds even when the request names a different execution workflow (e.g. the kanban agentic workflow): the loop wraps the execution; the named workflow governs how the work is driven, the loop governs the harness. For live-system tasks with work already in flight, initialize the run immediately and drive the probes only after the in-flight work converges, so probes verify live state instead of duplicating writes (issues, PRs, waves) into shared live locations.
    - When the request is a pure question, a status check, or conversation, answer it directly. A message with no task has nothing to probe; do not run a loop against it and say so in one line.
    - A round is 4+ agent sessions, each up to the probe budget (default 900 s), running under the user's model and keys. The user accepts this cost as the price of the default mode. Do not silently downgrade the mode; if a round will blow the budget or stall, stop and report it.
    - Banked harnesses stay banked. When a loop finishes, apply the promote report to this live profile yourself: install the recommended skill into the live profile's skills/, carry over the review-classified lesson text into the live workspace rules, verify the applied files, and report what landed (standing user instruction 2026-11-08: always promote the report).
```
