# Plan — Harden the Live Translate deploy

## Context

`FDE/Assignment_1_Live_Translate` runs two Fly.io apps — a public Node gateway
(`matteopilotto-livetranslate-gw`, :8787) and a private-via-Flycast Python AI
service (`ai-service-python`, :8000). Both are single-region (`iad`), 1GB
shared-cpu-1x, `auto_stop_machines='stop'`, `min_machines_running=0`, with **no
explicit health checks and no restart policy**. The README stretch goal asks to
*"harden the deploy — multi-region on Fly.io, autoscale, a health-check-driven
restart policy, and a GitHub Action that runs `bench.py` and `fly deploy` on
green."*

Two latent problems the current deploy has, that hardening must fix:

1. **The AI service's SQLite cache has no Fly volume** — it lives on ephemeral
   machine storage, so on Fly it is wiped on every redeploy/restart (docker-compose
   has a `/data` volume; Fly does not). This silently weakens the "cache survives a
   restart" Definition-of-Done item in production, and multi-region multiplies it.
2. **No health checks / restart policy** — a wedged process keeps receiving traffic.

**Decisions (from the user):**
- Cache state → **per-region Fly volume** (persistence + per-region warming, no new dependency).
- CI bench → **lightweight smoke on every push; full `bench.py` SLA gate nightly** (bounds LLM cost).
- Warm capacity → **both apps scale-to-zero** (`min_machines_running=0` stays; cold-start caveat documented).
- Regions → **`iad` (primary) + `sjc`** (US coast-to-coast).

Intended outcome: both apps run multi-region with persistent per-region caches,
Fly restarts unhealthy machines automatically, and a GitHub Action smoke-tests
every push and deploys both services on green — with a nightly SLA benchmark.

---

## Verified facts (no code changes needed for the cache move)

- `backend/ai-service-python/app.py:32` reads `TRANSLATION_DB_PATH` (default
  `translations.db`) → set it to `/data/translations.db` via fly.toml `[env]`,
  mount a volume at `/data`. Zero app code changes.
- Both `/health` endpoints return valid JSON (`app.py:137`, `server.js:96`) — ready
  to back Fly HTTP health checks.
- `benchmark/bench.py` takes `--target` / `--json` and exits non-zero on SLA fail
  (`main()` at `bench.py:101`) — the CI SLA gate. Its cache-miss path makes real
  paid LLM calls, which is why the full run is nightly, not per-push.
- GitHub Actions only reads `.github/workflows` at the **repo root**
  (`/Users/matteo/Documents/repos/multi-agent-course`), which currently has none.
  Workflows go there, scoped with `paths:` filters to this assignment.

---

## Changes

### 1. AI service fly.toml — persistent volume, health check, restart policy
File: `backend/ai-service-python/fly.toml`

- Add cache path env so the DB lands on the volume:
  ```toml
  [env]
    TRANSLATION_DB_PATH = "/data/translations.db"
  ```
- Mount a volume (created per region, step 4):
  ```toml
  [[mounts]]
    source = "translations"
    destination = "/data"
  ```
- Add an HTTP health check under the existing `[http_service]`:
  ```toml
  [[http_service.checks]]
    interval = "15s"
    timeout  = "2s"
    grace_period = "10s"
    method = "GET"
    path = "/health"
  ```
- Add a restart policy so a failed machine is retried:
  ```toml
  [[restart]]
    policy = "on-failure"
    max_retries = 10
  ```
- Keep `min_machines_running = 0`, `auto_stop_machines = 'stop'`,
  `auto_start_machines = true` (scale-to-zero, per the user's choice).

### 2. Gateway fly.toml — health check + restart policy (no volume; stateless)
File: `backend/gateway-node/fly.toml`

- Add the same `[[http_service.checks]]` block hitting `/health`.
- Add the same `[[restart]]` on-failure policy.
- Leave scale-to-zero settings as-is.

### 3. GitHub Actions — smoke+deploy on push, full bench nightly
New files at **repo root**:

**`.github/workflows/live-translate-ci.yml`** — `on: push`/`pull_request`
(paths: `FDE/Assignment_1_Live_Translate/**`) + `workflow_dispatch`.
- Job `smoke` (ubuntu): write `backend/ai-service-python/.env` from
  `secrets.OPENROUTER_API_KEY`; `docker compose up --build -d`; poll gateway
  `/health` until ready; POST the same `/translate` body twice and assert the
  **2nd response has `cached: true`** and Spanish output (a handful of cheap calls,
  not the full SLA workload); `docker compose logs` on failure. Working dir
  `FDE/Assignment_1_Live_Translate`.
- Job `deploy`: `needs: smoke`,
  `if: github.ref == 'refs/heads/main' && github.event_name == 'push'`. Uses
  `superfly/flyctl-actions/setup-flyctl` + `secrets.FLY_API_TOKEN`. Deploy order
  matters: **AI service first**, then gateway:
  ```
  flyctl deploy -c backend/ai-service-python/fly.toml
  flyctl deploy -c backend/gateway-node/fly.toml
  ```
  Then a post-deploy smoke: `curl -sf https://matteopilotto-livetranslate-gw.fly.dev/health`.

**`.github/workflows/live-translate-nightly-bench.yml`** — `on: schedule` (nightly
cron) + `workflow_dispatch`.
- Bring up the compose stack (deterministic, warm — avoids scale-to-zero cold-start
  flakiness against prod), run `python benchmark/bench.py --json bench-results.json`
  as the **SLA gate** (non-zero fails the run), and `upload-artifact` the JSON.
- `workflow_dispatch` accepts an optional `target` input so the full bench can be
  run manually against the live gateway when desired.

Required GitHub secrets (documented in the run notes): `OPENROUTER_API_KEY`,
`FLY_API_TOKEN`.

### 4. One-time provisioning + docs (commands, not committed code)
- Create per-region volumes for the AI service:
  ```bash
  fly volumes create translations --region iad --size 1 -a ai-service-python
  fly volumes create translations --region sjc --size 1 -a ai-service-python
  ```
- Scale both apps to one machine per region:
  ```bash
  fly scale count 1 --region iad,sjc -a ai-service-python
  fly scale count 1 --region iad,sjc -a matteopilotto-livetranslate-gw
  ```
  (Flycast routes each gateway to the nearest AI-service instance, so each region's
  cache warms independently.)
- Add a short **"Hardened deploy"** subsection to
  `FDE/Assignment_1_Live_Translate/README.md` under Part 4 documenting: the
  regions, the per-region volume + `TRANSLATION_DB_PATH`, the health-check/restart
  policy, the two workflows and their required secrets, and the **scale-to-zero
  cold-start caveat** (first request after idle may exceed miss-p95; nightly bench
  runs warm against compose to stay deterministic). Note that `fly autoscale` is the
  legacy Nomad command — this uses the Machines-native equivalent
  (`min_machines_running` + `auto_start/stop_machines` + `fly scale count`).

---

## Implementation notes (per CLAUDE.md)
- New branch off `main` (e.g. `harden-live-translate-deploy`); do not work on `main`.
- Small, scoped commits: (1) AI-service fly.toml, (2) gateway fly.toml, (3) CI
  workflow, (4) nightly-bench workflow, (5) README docs.
- No `Co-Authored-By` trailer on any commit.

---

## Verification

1. **fly.toml validity:** `fly config validate -c backend/ai-service-python/fly.toml`
   and the gateway equivalent → both pass.
2. **Volume + persistence on Fly:** after `fly deploy` of the AI service, `fly ssh
   console -a ai-service-python -C 'ls -la /data'` shows `translations.db`; run a
   translate, `fly apps restart ai-service-python`, repeat the same translate →
   `cached: true` (cache survived restart on Fly, not just in compose).
3. **Multi-region:** `fly status -a ai-service-python` and `... -a
   matteopilotto-livetranslate-gw` each list a machine in `iad` and `sjc`.
4. **Health check / restart:** `fly checks list -a matteopilotto-livetranslate-gw`
   shows the `/health` check passing; kill the process via `fly ssh` and confirm the
   machine restarts (`fly logs`).
5. **CI smoke locally:** from the assignment dir, `docker compose up --build -d`,
   then run the same two-call assertion the workflow uses → 2nd call `cached: true`.
6. **CI end-to-end:** push the branch → `live-translate-ci` `smoke` job goes green;
   merge to `main` → `deploy` job runs, both `fly deploy`s succeed, post-deploy
   `curl https://matteopilotto-livetranslate-gw.fly.dev/health` returns `status: ok`.
7. **Nightly bench:** trigger `live-translate-nightly-bench` via `workflow_dispatch`
   → `bench.py` exits 0, `bench-results.json` uploaded as an artifact.
