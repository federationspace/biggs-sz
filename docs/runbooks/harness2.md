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
