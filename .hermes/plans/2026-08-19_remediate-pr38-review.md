# biggs-sz PR #38 — Review Remediation Plan

> Source review: `federationspace/biggs-sz` PR #38, review `4972225720` by **shrinedogg** — state **CHANGES_REQUESTED**.
> Head `accc696` vs `origin/main` `b859372`, 94 files. This plan addresses every Critical, Warning, and Suggestion, plus the 23 inline comments.
> **Mode: planning only.** Nothing here is executed yet.

**Goal:** Turn the ai-system port into a set of changes that (a) contains no live secret, (b) actually reconciles and renders valid against the *target* cluster (k3s v1.34, 4× amd64, no GPU, CNPG 1.27.1, FluxInstance NetworkPolicies on), and (c) removes source-cluster (biggs.dog/cluster1) assumptions that do not hold here.

**Architecture of the fix:** The review shows two distinct problem classes:
- **(A) In-place bugs** — wrong flags, wrong tool names, over-broad RBAC, unauth routes, committed secrets, GPU labels on CPU workloads, `prune: false`, unpinned digests. Fixable by editing manifests.
- **(B) Missing target infrastructure** — no NVIDIA GPU / device plugin / operator, no CNPG ≥1.29, no oauth2-proxy, no RustFS `runsc` object, wrong SA issuer for substrate. Whole subsystems (**vLLM on GPU, embeddings-on-GPU, substrate, all 5 agents, GPU-pinned MCP pods**) **cannot run** until these exist.

Because of (B), the central decision this plan forces is **scope**, covered in the Strategic Decision section. The reviewer explicitly recommends splitting into **stacked PRs** (substrate / kagent / vLLM / MCP) so each is independently validatable and revertible — this plan is organized to support that.

---

## ⚠️ Phase 0 — Security incident (do NOW, before any code work)

**Finding #1 (Critical): live Grafana service-account token committed to Git history.**
- File: `.../ai-system/kagent/app/grafana-mcp-token-secret.yaml:15` — decoded value is 46 bytes, starts with `glsa_`, absent from `origin/main` (this PR introduces it).
- Removing the line in a follow-up commit is **NOT sufficient** — the token stays in history on the pushed branch.
- **Actions (external, not a manifest edit):**
  1. Revoke/rotate the token in Grafana immediately (Administration → Service accounts → delete the token).
  2. Because it is in the pushed branch history, either rewrite branch history (`git rebase`/filter to purge the blob, force-push) or treat the token as permanently burned (rotation covers this — rotation is the reliable control).
  3. Create the replacement as a 1Password item in the **biggs-sz** vault; wire via ExternalSecret (Phase 1, task 1.1).

> This is the only item that cannot wait for the PR cycle. I can execute the ExternalSecret conversion and branch-history purge on request; the Grafana-side revocation must be done by a token admin.

---

## Strategic Decision (resolve before Phase 3+)

The target cluster has **no GPU and no path to one in this repo**. That makes these unrunnable as-is: `vllm`, `embeddings` (if GPU-pinned), `substrate` (+ atelet/worker/runsc), and all 5 SandboxAgents. Options:

- **Option A — Land a CPU-only, actually-runnable subset first (RECOMMENDED).** First PR = kagent control plane + CPU MCP servers (flux, exa, victoria-metrics, codebase-memory, mindwtr) + embeddings on CPU + CNPG kagent DB. **Descope** vLLM, substrate, agent-sandbox, csi-driver, kagent-podcert-patch, and the GPU agents into later stacked PRs gated on real GPU hardware + a GPU-operator Kustomization. kagent's default model provider would temporarily point at an external/remote OpenAI-compatible endpoint or be marked not-ready.
- **Option B — Provision the GPU prerequisites first**, in separate PRs: (1) NVIDIA driver + device plugin + GFD labels Kustomization, (2) CNPG upgrade to ≥1.29, (3) oauth2-proxy. Then rework this PR on top. Longer, but keeps the full stack.
- **Option C — Keep one big PR** and fix everything in place, keeping GPU workloads with `wait: false` + not registered in the root until hardware exists. Highest risk of a stuck reconcile; the reviewer dislikes the `wait: true`+dependency chain.

**DECIDED: Option B.** Provision GPU + CNPG + SSO prerequisites first, then rework this PR on top of them.

**Hardware status (confirmed with maintainer 2026-08-19): no GPU is physically installed in any biggs-sz node yet.** This blocks the device-plugin/GFD half of Option B at the "nothing to expose" stage — a device plugin Kustomization can be *drafted* now but cannot go live (and shouldn't be merged/reconciled) until the RTX 3090 is physically racked. The plan below splits Option B into an **unblocked track** (CNPG upgrade, oauth2-proxy — pure software, no hardware dependency) and a **blocked track** (GPU driver/device-plugin/GFD — drafted now, merged only once hardware exists).

---

## Phase 1 — Secrets & credential hygiene

| # | Finding | File | Action |
|---|---|---|---|
|1.1|Grafana token (crit #1)|`kagent/app/grafana-mcp-token-secret.yaml`|Delete the hardcoded Secret; replace with `ExternalSecret` vs `onepassword-connect`, item in **biggs-sz** vault. Fix comment vault refs.|
|1.2|RustFS admin creds committed (`rustfsadmin`/`rustfsadmin`) reused by RustFS/atelet/bucket-init|`substrate/app/runsc-cache.yaml:41`|ExternalSecret for creds; reference from all 3 consumers; add NetworkPolicy around RustFS API/console. (Descoped under Option A — substrate not landed.)|
|1.3|MCP API key reuses a Pocket-ID token verbatim|`kagent/app/external-secret.yaml`|Generate a dedicated random key; store only its **hash** in the gateway credential Secret; keep raw key client-side only.|
|1.4|Secret comments point at **biggs-dog** vault|`exa-mcp/app/secret-ref.yaml`, `codebase-memory-mcp/app/externalsecret.yaml`, others|Rewrite all remoteRef/comment references to the biggs-sz vault (the target ClusterSecretStore only serves that vault).|
|1.5|`mindwtr-db` seed Secret referenced but never created; manual `kubectl apply` step contradicts ESO policy|`mindwtr-mcp/app/*`|Create the seed via ExternalSecret or drop the seed approach (see Phase 4 mindwtr rework). No manual apply.|

---

## Phase 2 — Make it render-valid & non-blocking on the target

| # | Finding | File | Action |
|---|---|---|---|
|2.1|CNPG 1.27.1 rejects name-only pgvector extension (needs `image`; catalog inheritance is 1.29+) (crit-adjacent)|`databases/cnpg/databases/cnpg-kagent.yaml:44`|**Decision:** either (a) upgrade cnpg operator+chart+CRDs to ≥1.29 in a *separate prerequisite PR* (verify ImageVolume gate + containerd 2.1+), or (b) stay on 1.27.1 and set the pgvector `image:` inline per extension. Recommend (b) for this PR.|
|2.2|Webhook rejects `archive_mode: "off"` (fixed param)|`databases/cnpg/databases/cnpg-kagent.yaml:47`|Remove the parameter, OR add `metadata.annotations.cnpg.io/skipWalArchiving: enabled` if WAL archiving is intentionally off.|
|2.3|`ClusterImageCatalog` is cluster-scoped but `targetNamespace: cnpg-system` stamps a namespace → API server rejects it, blocking cnpg-secrets/databases|`databases/cnpg/app/postgresql-minimal-trixie-catalog.yaml:6`|Move the catalog into a Kustomization **without** `targetNamespace`; order `cnpg-databases` after it. (Or drop the catalog entirely if 2.1(b) inlines images.)|
|2.4|Catalog PG versions wrong: majors 13/14/16 point at 15.14/17.10/17.10|`databases/cnpg/app/postgresql-minimal-trixie-catalog.yaml`|Copy the upstream CNPG catalog **verbatim** (13→13.22, 14→14.23, 16→16.14).|
|2.5|All 16 new Kustomizations use `prune: false` (repo convention is `prune: true`)|every `.../ai-system/*/ks.yaml`|Set `prune: true` across the new stack; document any intentional retention exception.|
|2.6|`flux-operator-mcp` source uses `semver: "*"` (auto-adopts hourly)|`flux-system/sources/flux-operator-mcp-oci.yaml:20`|Pin `ref.tag: "0.58.0"` (the version validated in review); let Renovate propose upgrades.|
|2.7|New lines in sources kustomization carry CRLF (`git diff --check` flags)|`flux-system/sources/kustomization.yaml:22-29`|Rewrite those lines with LF endings.|
|2.8|kagent OCI chart relies on `DisableChartDigestTracking` helm-controller feature gate (uses `.Chart.Version` in labels/default tags); target FluxInstance doesn't set it|`clusters/cluster0/flux-system/flux-instance.yaml` + kagent HR|Either enable the feature gate on the target FluxInstance, or pin explicit image tags in kagent values so labels/tags don't depend on the gate. Decide + implement.|

---

## Phase 3 — Remove source-cluster assumptions (target reality)

| # | Finding | File | Action |
|---|---|---|---|
|3.1|GPU prerequisite unmanaged after dropping `nv-gpu-operator` dep; `wait: true` on vllm blocks kagent + all MCP behind it (crit-adjacent, #11)|`vllm/ks.yaml:11`|Per Strategic Decision: **Option A** descope vllm from the root until a GPU-stack Kustomization exists; **Option B/C** add a declarative NVIDIA driver+device-plugin+GFD Kustomization ahead of vllm.|
|3.2|`nvidia.com/gpu.present` selector on **CPU-only** workloads (codebase-memory, exa, flux-mcp post-render, mindwtr, victoria-metrics, all 5 Agents) → unschedulable on all 4 nodes|`codebase-memory-mcp/app/deployment.yaml:90` + the others|Remove the GPU nodeSelector from every CPU-only Deployment/Agent and the flux-mcp post-render patch.|
|3.3|Substrate client JWT issuer is source Omni/KubeSpan ULA; target issuer is `https://kubernetes.default.svc.cluster.local` (crit #4)|`substrate/app/helmrelease.yaml:157`|Remove the issuer override or set the k3s issuer; JWKS URL can stay in-cluster. (Descoped under Option A.)|
|3.4|`flux-mcp` disables chart NetworkPolicy citing a CNP that doesn't exist; target flux-system default-deny blocks ai-system→9090|`flux-mcp/app/helmrelease.yaml:51`|Set `networkPolicy.create: true` and `networkPolicy.ingress.namespaces: [ai-system]`.|
|3.5|`embeddings` (CPU Infinity) GPU-pinned + depends on kagent, gating it behind GPU stack; model cache is emptyDir (re-downloads ~2.3 GB each restart)|`embeddings/app/*`, `embeddings/ks.yaml`|Drop GPU selector; drop the kagent dependency where not required (it needs the ModelConfig CRD only — keep `dependsOn: kagent-crds` instead); back the HF cache with a PVC (ceph-block).|
|3.6|`substrateWorkerPool.template` ignored by kagent 0.9.12 (wrong CRD shape) → worker not GPU-pinned|`kagent/app/helmrelease.yaml:212`|Patch the rendered WorkerPool via postRenderer (`spec.template.nodeSelector`), or use a chart version exposing it. (Descoped under Option A.)|
|3.7|`executeCodeBlocks` ignored by kagent 0.9.12 (ADK bug per its own CRD)|cilium agents, flux agent|Stop advertising Python execution, or document it as inert until a chart bump.|
|3.8|`replicas` unmanaged + VMRule omits down-alert, justified by a gpu-arbiter that exists only in source|`vllm/app/deployment.yaml`, `vllm/app/vmrule.yaml`|Set explicit `replicas: 1` and add the down alert (no arbiter here). (Descoped with vllm under Option A.)|

---

## Phase 4 — Functional bugs (MCP servers, agents, metrics, catalog)

| # | Finding | File | Action |
|---|---|---|---|
|4.1|mindwtr ignores `--db-path` (only `--db` exists) → seeded DB never used (crit #6)|`mindwtr-mcp/app/deployment.yaml:174`|Change arg to `--db=/data/mindwtr.db`.|
|4.2|mindwtr Agent allowlist has **zero** overlap with real `mindwtr_*` tool names (crit #7)|`mindwtr-mcp/app/agent.yaml:151`|Replace with the real 27 `mindwtr_*` names; adjust prompt for capabilities without dedicated tools.|
|4.3|mindwtr write tools vs read-only DB (seed `chmod 0444`, `/data` mounted `readOnly`, server not `--write`); task state on emptyDir|`mindwtr-mcp/app/*`|Make the DB writable (RWX/RWO PVC), start server with `--write`, drop `readOnly`. Reconcile with 4.1/1.5.|
|4.4|mindwtr pod runs `apk add` + `npm install` (no lockfile, as root) every startup|`mindwtr-mcp/app/deployment.yaml`|Build an immutable image in CI and reference it (follow-up); at minimum pin versions + lockfile.|
|4.5|codebase-memory still clones/indexes `shrinedogg/biggs.dog` (crit-adjacent)|`codebase-memory-mcp/app/deployment.yaml:232`|Retarget git-sync + project name to `federationspace/biggs-sz`; update Agent prompt, RemoteMCPServer, ExternalSecret comments.|
|4.6|VictoriaMetrics Agent allowlist names tools the v1.120.1 server doesn't expose (`tenants`, `k8s_get_resources`, `k8s_describe_resource`)|`victoria-metrics-mcp/app/agent.yaml`|Replace with real tools from `tools/list` on v1.120.1.|
|4.7|VMRule + dashboard query renamed vLLM metrics|`vllm/app/vmrule.yaml`, `vllm/app/grafana-dashboard.yaml`|`vllm:gpu_cache_usage_perc`→`vllm:kv_cache_usage_perc`; `vllm:time_per_output_token_seconds`→`vllm:inter_token_latency_seconds` (or `vllm:request_time_per_output_token_seconds`). (Descoped with vllm under A.)|
|4.8|flux Agent example prompt references a **cluster1** GitRepository|`flux-mcp/app/agent.yaml`|Update prompt to cluster0.|
|4.9|`exa-mcp` is the only new MCP Kustomization without `wait: true`|`exa-mcp/ks.yaml`|Add `wait: true` for consistency.|
|4.10|kagent doesn't depend on `cnpg-databases`/`substrate`; substrate-agents KS has no `dependsOn`; controller DB timeout 120s + pgvector needs operator privilege chain|`kagent/ks.yaml`, `kagent/substrate-agents/ks.yaml`|Add `dependsOn: cnpg-databases` (and substrate where applicable); verify ordering so the DB + extension exist before the controller migrates.|

---

## Phase 5 — Security hardening (RBAC, routes, netpol, PSS)

| # | Finding | File | Action |
|---|---|---|---|
|5.1|kagent-tools renders **cluster-admin**; agents expose apply/delete/patch/exec/helm-uninstall (crit #5)|`kagent/app/helmrelease.yaml:90`|Set `rbac.namespaces`; replace tools role with least-privilege rules; put mutating tools behind a separate authz boundary.|
|5.2|vLLM public route `PathPrefix /` exposes unauth endpoints (`/invocations`,`/metrics`,`/tokenize`,`/update_weights`,…) (crit #2)|`vllm/app/vllm-route.yaml:30`|Match `/v1` only; enforce gateway-level auth; explicit deny on everything else. (Descoped with vllm under A.)|
|5.3|kagent MCP route `PathPrefix /` exposes the whole controller API (incl `/api/`) to any MCP-key holder|`kagent/app/kagent-mcp-route.yaml:40`|Restrict match to `/mcp`.|
|5.4|All 3 new routes omit `sectionName` → also attach to plaintext **HTTP:80** listener|`vllm-route.yaml`, `kagent-route.yaml`, `kagent-mcp-route.yaml`|Bind the HTTPS listener by name (`sectionName: wildcard-gregbob-net-https`); add a RequestRedirect route if 80 must stay open.|
|5.5|oauth2-proxy `/oauth2/auth` returns 202 but agentgateway extAuth treats only 200 as success → fail-closed loop; cross-ns backend needs a **ReferenceGrant** in `auth`|`kagent/app/kagent-ui-auth-policy.yaml:34`|Use an ext-auth path/config returning 200; add ReferenceGrant in `auth` ns; validate full login. (Blocked on oauth2-proxy existing — Strategic Decision.)|
|5.6|`controller.auth.mode` stays `unsecure` → everyone is `admin@kagent.dev`|`kagent/app/helmrelease.yaml`|Wire trusted-proxy mode, or explicitly document single-user posture.|
|5.7|Namespace labeled PSS `enforce/audit/warn=privileged`|`namespace.yaml:14`|Set `enforce=baseline` (min `audit/warn=restricted`); move atelet/CSI (the only things needing privilege) to a dedicated system namespace. (Privilege needs shrink further once substrate is descoped.)|
|5.8|flux Agent `executeCodeBlocks: true` with no securityContext → privileged runner|`flux-mcp/app/agent.yaml`|Add restrictive `securityContext` (runAsNonRoot, drop ALL) or disable code execution.|
|5.9|5 SandboxAgents drop `kagent-builtin-prompts` + safety-guardrails while keeping delete/apply/patch/exec|`kagent/substrate-agents/*`|Re-add the builtin prompt data source + guardrails; trim mutating tools. (Descoped with substrate under A.)|
|5.10|`kagent/rbac-admin.yaml` grants wildcard reads incl all Secrets to cilium agent SAs; not referenced by any Kustomization|`kagent/rbac-admin.yaml`|Delete it, or narrow to specific resources and wire deliberately.|
|5.11|flux-mcp replacement ClusterRole still grants cluster-wide `pods/log` + binds `view`|`flux-mcp/app/rbac-readonly.yaml`|Scope reads to needed namespaces; drop the broad `view` binding.|
|5.12|ate-controller cluster-wide get/list/watch on all Secrets+ConfigMaps; atelet/runsc-cache DaemonSets privileged on **every** node incl control plane; agent-sandbox controller can create Pods/PVCs/NetworkPolicies cluster-wide|`substrate/*`, `agent-sandbox/*`|Scope RBAC to `ai-system`; constrain DaemonSets to the sandbox node; add admission constraints. (All descoped under Option A.)|
|5.13|No NetworkPolicy/CNP selects ai-system pods; source ai-system policy set not ported → every unauth MCP endpoint reachable cluster-wide|`ai-system/*`|Port/author a default-deny + explicit-allow NetworkPolicy set for ai-system.|
|5.14|vLLM `--trust-remote-code` on unpinned HF revision + tag-only image; grafana-mcp `mcp/grafana:latest` Always-pull|`vllm/app/deployment.yaml`, kagent grafana-mcp subchart|Pin model revision + image digest; add pod securityContext; pin grafana-mcp digest. (vllm part descoped under A.)|

---

## Phase 6 — vLLM model/context for the RTX 3090 (only if GPU stack is in scope)

- **Finding #3 (Critical):** `--max-model-len=177184` cannot fit on 24 GiB: 20.16 GiB weights + 5.41 GiB FP8 KV = 25.57 GiB floor; raw-KV ceiling ~94k tokens at util 0.96. With `wait: true` + kagent dependency, vLLM init failure blocks the stack.
- **Finding (NVFP4):** the pinned NVFP4 checkpoint is Blackwell-only; will not execute on Ampere.
- **Actions:** choose an **Ampere-validated checkpoint** (AWQ/GPTQ INT4 or a smaller model), pin its revision + image digest, and set `--max-model-len` from a **measured** ceiling on a real 3090 (start ≤ 90k). Update served-model-name references in the kagent provider accordingly.
- **If Option A:** this entire phase moves to the later GPU-gated PR; vLLM is not in the first landable PR.

---

## Phase 7 — Suggestions / polish

| # | Suggestion | Action |
|---|---|---|
|7.1|`automountServiceAccountToken: false` on codebase-memory/exa/mindwtr/victoria-metrics (no API need)|Add the field to those pod specs.|
|7.2|11/16 image refs tag-only|Digest-pin (vllm-openai, git-sync, mcp-proxy, exa, aws-cli, codebase-memory-mcp, mindwtr base, grafana-mcp, etc.).|
|7.3|`renovate.json` lacks substrate-stack grouping (substrate/substrate-crds/ateom/ateapi move together, automerge off)|Add the grouping rule matching the manifests' stated policy. (Only if substrate stays in scope.)|
|7.4|Split into stacked PRs (substrate / kagent / vLLM / MCP)|Adopt as the delivery structure — aligns with Strategic Decision Option A.|
|7.5|kagent-podcert-patch renders **zero** resources, not referenced by parent, CSI ClusterIssuer omitted + bare SelfSigned unsupported + init writes to readOnly CSI vol|Remove the `kagent-podcert-patch` + `csi-driver` subtree until pinned substrate supports it.|
|7.6|agent-sandbox controller image `v0.5.0` from `v0.5.5` checkout (API/CRD skew); `reconcileStrategy: ChartVersion` won't repackage on new Git revs|Pin `image.tag: v0.5.5`; revisit source strategy. (Descoped with sandbox under A.)|
|7.7|runsc never uploaded to a fresh RustFS bucket; cache DS + SandboxConfig reference an object only in source cluster|Add a GitOps-managed bootstrap Job/pinned image to upload the verified binary. (Descoped under A.)|

---

## Recommended execution order (Option B — DECIDED)

Status legend: 🟢 unblocked (software-only, can start now) · 🔴 blocked (needs physical GPU hardware) · 🟡 drafted-but-not-merged (write the manifests now, gate reconciliation until hardware lands).

1. **Phase 0** (secret rotation) — ✅ done (`4d6666f`, PR #38 updated). Awaiting maintainer token rotation in Grafana.
2. 🟢 **PR-Prereq-1 "CNPG ≥ 1.29 upgrade"** (unblocks 2.1/2.3 done the "real" way instead of the 1.27.1 workaround):
   - Bump `databases/cnpg/app/helmrelease.yaml` chart version to a CNPG ≥1.29 release; verify CRD bump included.
   - Verify target node containerd ≥2.1 and the Kubernetes `ImageVolume` feature gate (may need a k3s config change — check `--feature-gates` on the target; this is a live-cluster check, flag if k3s version doesn't support it).
   - Re-test `cnpg-gitea`/`cnpg-homarr`/`cnpg-renovate`/`cnpg-rreading-glasses` (existing DBs) still reconcile clean after the bump before adding kagent's pgvector Cluster.
   - Once confirmed: cnpg-kagent can use the catalog/imageCatalogRef approach as originally ported (Phase 2 items 2.1(a), 2.2, 2.4 — fix archive_mode + catalog PG versions regardless of path taken).
3. 🟢 **PR-Prereq-2 "oauth2-proxy + SSO"**:
   - New app `apps/auth/oauth2-proxy/` (or similar) — HelmRelease/manifests, `auth.gregbob.net` HTTPRoute, ExternalSecret for OAuth client creds.
   - Fix the extAuth 200-vs-202 mismatch (5.5) as part of standing it up; add the ReferenceGrant in `auth` ns for agentgateway's cross-namespace extAuth backend.
   - Wire `controller.auth.mode` trusted-proxy (5.6) once SSO identity is available.
4. 🟡 **PR-Prereq-3 "GPU stack (drafted, gated)"** — ✅ **drafted 2026-08-19**: [PR #39](https://github.com/federationspace/biggs-sz/pull/39) (`feat/nvidia-gpu-operator-draft`, GitHub Draft state, base `main`). **DO NOT MERGE.**
   - `flux-system/sources/nvidia-repo.yaml` (NGC HelmRepository) + `kube-system/nvidia-gpu-operator/{ks.yaml,app/helmrelease.yaml}` (GPU Operator chart `gpu-operator` v26.3.3).
   - Neither file is registered in any `kustomization.yaml` — confirmed inert (kube-system root still renders 7 resources, sources root still renders 19, identical to before these files existed).
   - Driver/toolkit model inverted vs. the source (biggs-sz is plain k3s, not Talos): `driver.enabled: true`, `toolkit.enabled: true` (source disables both since Talos provides them via system extensions).
   - `nfd.enabled: false` — reuses biggs-sz's existing standalone NFD instead of a second master.
   - Time-slicing present but disabled (`create: false`) pending a sharing-need decision.
   - **5 TODOs left inline before un-drafting**: node targeting, k3s containerd config path verification (chart defaults assume vanilla `/etc/containerd`, k3s uses a different path — top priority to verify), `nfd.enabled: false` compatibility against the live NFD chart (asserted, not render-tested), time-slicing replica decision, DCGM-exporter/VMRule/dashboard porting (deferred).
   - **Un-draft steps**: set node targeting → register both files in their `kustomization.yaml` → verify the 5 TODOs against the live cluster → convert Draft→Ready → real review → merge.
5. 🔴 **[BLOCKED ON HARDWARE] PR-1 "kagent core + full ai-system stack"**: once PR-Prereq-1/2/3 are live and the RTX 3090 is racked + PR-Prereq-3 is merged, rework the current PR #38 branch on top: apply all remaining Phases (1 remainder, 2 remainder, 3, 4, 5, 6, 7) as one coherent PR (Option B keeps the full stack together rather than the Option A CPU-only slice). Includes vLLM (Phase 6 — Ampere-validated checkpoint), substrate (3.3, 5.12), agent-sandbox (7.6), all GPU-pinned MCP/agent workloads (3.2 fix — remove GPU selector only from the genuinely CPU-only ones; keep it correctly on GPU-bound ones), csi-driver, kagent-podcert-patch (or drop per 7.5 if still unsupported by pinned substrate).
6. 🟢 Independent of hardware, can land inside step 5 or earlier as a standalone PR: RustFS creds + `runsc` upload (1.2/7.7), renovate substrate-stack grouping (7.3) — these only need to exist before substrate is turned on, not before hardware.

## What can start right now (given no GPU hardware yet)

Since PR-1 (step 5) is hardware-blocked, the productive unblocked work is:
- **PR-Prereq-1 (CNPG upgrade)** — pure software, testable against the live cluster's existing 4 databases.
- **PR-Prereq-2 (oauth2-proxy)** — pure software, needed regardless of GPU status (kagent UI auth).
- **PR-Prereq-3 (GPU manifests, drafted only)** — can be written and reviewed now so it merges same-day once hardware arrives, but must not go live.
- Fixing the **CPU-only bugs from Phases 1, 4, 5, 7** that don't depend on GPU/substrate at all (mindwtr, codebase-memory, victoria-metrics-mcp, exa-mcp, flux-mcp, RBAC/route/PSS hardening) can be drafted in parallel on top of the current branch, to be folded into PR-1 once unblocked — this avoids re-discovering the same fixes later.

## Files likely to change (first PR slice)
- `.../kagent/app/{grafana-mcp-token-secret.yaml→externalsecret,helmrelease.yaml,kagent-mcp-route.yaml,external-secret.yaml,rbac-admin.yaml}`
- `.../{flux-mcp,exa-mcp,victoria-metrics-mcp,codebase-memory-mcp,mindwtr-mcp}/app/*` and their `ks.yaml`
- `.../embeddings/{app/*,ks.yaml}`
- `.../namespace.yaml`
- `databases/cnpg/databases/cnpg-kagent.yaml`, `databases/cnpg/app/postgresql-minimal-trixie-catalog.yaml` (+ its ks/registration)
- `flux-system/sources/{kustomization.yaml,flux-operator-mcp-oci.yaml}`
- root `ai-system/kustomization.yaml` (descope registrations) + all remaining `*/ks.yaml` (`prune: true`)
- new: an ai-system NetworkPolicy set

## Validation (per PR, before push)
- `kubectl kustomize clusters/cluster0/kubernetes/apps/<ns>` exit 0 for every touched ns.
- `flux build kustomization <name> --dry-run` for each new/edited Flux Kustomization.
- `kubeconform -strict` against the pinned CRD schemas (kagent 0.9.12, Gateway API v1.4.1, agentgateway v2.3.0, CNPG 1.27.1).
- `git diff --check` (catches the CRLF regression, 2.7).
- Targeted repro for behavioral fixes: `tools/list` for mindwtr/victoria-metrics allowlists; confirm `--db` flag; confirm route path matches; grep for `nvidia.com/gpu.present` = 0 on CPU workloads; grep for `prune: false` = 0.

## Risks / open questions

1. ~~**Scope (A/B/C)**~~ — **DECIDED: Option B** (2026-08-19). No GPU hardware yet, so PR-1 is hardware-blocked; unblocked prereq work (CNPG, oauth2-proxy, drafted GPU manifests) proceeds now.
2. **CNPG** — Option B commits to the real fix: upgrade to ≥1.29 (verify `ImageVolume` gate + containerd ≥2.1 on the k3s target — **needs a live-cluster check**, flag if unsupported and fall back to the inline-image workaround for 1.27.1).
3. **Model provider while GPU is unavailable** — does kagent's default ModelConfig point at an external/remote OpenAI-compatible endpoint in the interim, or does the whole ai-system stack simply stay unmerged until PR-1? (Under Option B the whole stack lands together once hardware exists, so likely the latter — confirm.)
4. **helm-controller feature gate** (2.8) — enable on FluxInstance (affects all Helm releases) vs pin kagent tags. Cluster-wide implication.
5. **Secret history purge** — ✅ resolved: branch history rewritten (`accc696`→`4d6666f`), force-pushed. Token rotation in Grafana still pending on the maintainer.
6. **GPU hardware ETA** — unknown; PR-Prereq-3 should be written now but its merge (and thus PR-1) is gated on a physical event outside this repo's control. Ask the maintainer for a rough timeline so prereq work can be sequenced.
