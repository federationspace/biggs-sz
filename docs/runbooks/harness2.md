# Runbook: Harness² workbench (`hermes/harness2`)

How to run the [harness2-hermes](https://github.com/shrinedogg/harness2-hermes)
loop (Harness², arXiv:2610.14224) in cluster0, and what the first real round
taught. Manifests: `clusters/cluster0/kubernetes/apps/hermes/harness2/`.

## What runs where

| Object | Purpose |
| --- | --- |
| Deployment `harness2` | Hermes home at `/opt/data` on PVC `harness2-data` (ceph-block 10Gi). No chat platforms. Web dashboard on port 9119, published at `harness2.gregbob.net` behind basic auth (ExternalSecret `harness2-dashboard`, 1Password item `harness2-dashboard`). |
| `/opt/data/harness2-hermes` | The scaffold checkout, pinned at `0ec326d`. Holds `candidates/`, `runs/` and the improvement `library/`, the only long-term state. It lives on the PVC only. |
| CronJob `harness2-smoke` | Mondays 07:00 America/New_York. Runs the scaffold's `smoke.sh` in an emptyDir home; failure raises `KubeJobFailed` to Matrix. |

The workbench shares only two things with the Matrix bot: the `config.yaml`
key of `hermes-config` (model wiring) and `NOUS_API_KEY` from
`hermes-secrets`. It never gets the bot's Matrix token or dashboard
credentials, because the scaffold copies `$HERMES_HOME/.env` into every probe
profile and probes run unattended with a terminal tool.

## Dashboard

`https://harness2.gregbob.net` (login from the 1Password item
`harness2-dashboard`). It is a full Hermes dashboard on the workbench home:
browse `runs/`, `candidates/` and `library/` with the file browser, read
sessions, and chat. Dashboard chats run on the default profile with the
shared free model (weak at Harness² judgement stages; see below), and they
have a terminal tool on the workbench volume, so the checkout hygiene rule
below applies to them too. The workbench has no Kubernetes API access.

## Getting a shell

Always work as the `hermes` user. `kubectl exec` defaults to root, and files
or profiles created as root break later runs.

```sh
kubectl -n hermes exec -it deploy/harness2 -c harness2 -- su hermes -s /bin/bash
export HERMES_HOME=/opt/data
cd /opt/data/harness2-hermes
```

## Running a round

Follow the scaffold README's "Per-task protocol". Notes for this cluster:

- **Run long steps detached** (`setsid nohup ... &`, writing the exit code
  to a file) so a dropped `kubectl exec` does not kill a 15-minute probe.
- **Make the task self-contained.** Put a frozen snapshot of the inputs in
  `runs/<task>/source/` and tell the task to work only from it. A task that
  makes the agent find its own inputs (repos, tokens) measures input
  discovery, not the harness. Never put rubrics, scores or answer keys in
  `task.md` or `source/`.
- **Stage sessions use their own profile.** Editors, composer and reflector
  run as `hermes -p harness2-stage chat --in /opt/data/harness2-hermes
  --query-file <prompt> --format stream-json --source tool`. Build each prompt
  by appending the paths (candidate dir, reference log, and so on) to the stock
  file in `prompts/`. Probes always go through `scripts/run_probe.sh`, which
  inherits the shared model.
- **The stage model is the weak link.** Probes do fine on the bot's free
  model; the judgement stages do not. Set the stage model in
  `/opt/data/h2-stage-tree/config.yaml`, then re-run
  `python3 scripts/materialize_profile.py /opt/data/h2-stage-tree harness2-stage --home /opt/data --budget 1500`.
  Check its trajectory reads by hand after every stage (which files it opened,
  whether its notes match what the rollouts did); a short factual quiz on the
  trajectories passed on models that then failed the real stage.
- **Bank deliberately.** `library_add.py --adopted KEEP_BASE --no-entry` is
  a valid result. Append an operator note to the entry's `EXPERIENCE.md` when
  the loop's own record is wrong, rather than banking an inaccurate one.
- **Check the checkout after every stage.** Stage sessions run unattended
  with a terminal tool in `/opt/data/harness2-hermes` and do improvise: one
  editor tried `pip install`, wrote a file under a mistyped relative path, ran
  `rm -rf` to undo it, and left a stray script at the repo root. Run
  `git status --short` and expect changes only under `candidates/`, `runs/`
  and `library/`. Approvals stay on `mode: smart`; never set them off for
  a stage or probe profile.

## Known scaffold behaviour (at `0ec326d`)

- **`smoke.sh` and `version-check.sh` misreport the version** as
  `hermes CLI missing`: `hermes --version | head -1` under `pipefail` exits 1
  on `BrokenPipeError`. The CronJob patches it to `sed -n 1p` before running.
  Inside the workbench, `runs/.last-green-version` therefore reads
  `hermes CLI missing`, and a manual `smoke.sh` there says "nothing to do";
  delete that file to force a run.
- **A tree's top-level `scripts/` cannot override a skill script of the same
  name.** `run_probe.sh` copies the tree's `scripts/` first, then each skill's
  `scripts/*.py` over it.
- **Deleting a probe profile leaves its s6 service slot** registered (stopped,
  with an `s6-log` process). Harmless; slots clear on the next pod restart.
  Delete probe profiles after a round:
  `hermes profile delete -y harness2-<task>-<id>`.

## Export the library

```sh
POD=$(kubectl -n hermes get pod -l app.kubernetes.io/name=harness2 -o name | cut -d/ -f2)
kubectl -n hermes cp -c harness2 "$POD:/opt/data/harness2-hermes/library" ./harness2-library
```

## Upgrading

- **Hermes image** (Renovate bump): bump `deployment.yaml` and `cronjob.yaml`
  together, then run the smoke job by hand after the merge reconciles:
  `kubectl -n hermes create job --from=cronjob/harness2-smoke smoke-$(date +%s)`
  and check the log ends `smoke: GREEN Hermes Agent v...`.
- **Scaffold** (`HARNESS2_HERMES_REF`, not Renovate-tracked): read the upstream
  diff, bump the ref in both manifests, then update the existing checkout by
  hand, since the init container only clones onto an empty volume:
  `git -C /opt/data/harness2-hermes fetch && git -C /opt/data/harness2-hermes checkout --detach <sha>`.
  Local changes under `runs/`, `candidates/` and `library/` survive a
  checkout only if upstream did not touch those paths; check `git status`
  first. Drop the CronJob's `sed` patch once upstream fixes the version read;
  its `grep` guard fails the job if the patched line moves.

## History

- 2026-10-28: workbench (#289) and smoke CronJob (#290) deployed.
- 2026-10-29: first round, `renovate-risk` (risk table for open Renovate PRs).
  Banked KEEP_BASE / NO_ENTRY with an operator note. The free-model stage
  attempt (composer skipped, then misread, the rollouts) is archived in
  `runs/renovate-risk/_attempt-beam/`. The `inception/mercury-2.5` re-run
  produced only an inert edit and a reflector record that claimed byte
  identity without diffing.
