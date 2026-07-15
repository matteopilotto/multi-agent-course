# Deploy runbook — US multi-region + shared Redis cache

This is the operational runbook for the production topology described in
[`../.claude/plans/latency-mitigations-client-cache-redis-multiregion.md`](../.claude/plans/latency-mitigations-client-cache-redis-multiregion.md)
(Workstream C). The `fly.toml` for both apps is committed; the steps below are the
one-time / occasional CLI actions that stand up the infrastructure. They mutate live,
paid Fly resources, so run them yourself — they are not part of any automated build.

**Apps**

| Role | Fly app | Public? |
| --- | --- | --- |
| Gateway (Node) | `matteopilotto-livetranslate-gw` | Yes (Anycast) |
| AI service (Python) | `ai-service-python` | No — Flycast private only |

**Regions:** `iad` (US-East, primary) and `sjc` (US-West).

---

## C1 — Provision Upstash Redis (shared, persistent L2 cache)

Redis is the persistent cache tier (`CACHE_BACKEND=redis`). It must be reachable only
from the AI service on the private network — never from the browser or the gateway.

```bash
# Upstash-managed Redis on Fly, in the primary region.
fly redis create --name livetranslate-cache --region iad
# Capture the connection string it prints (starts with rediss://). Retrieve it later with:
fly redis status livetranslate-cache        # shows the private rediss:// URL
```

Optionally add a **read replica in `sjc`** so US-West AI machines don't cross-region on
L2 misses (the in-memory L1 tier absorbs repeats regardless):

```bash
# --replica-regions takes the full comma-separated list of replica regions (it
# replaces the set, it doesn't append), so list every replica you want each time.
fly redis update livetranslate-cache --replica-regions sjc
```

Wire the URL + backend selector onto the **AI service only**:

```bash
# Use the exact "Private URL" that `fly redis status livetranslate-cache` prints.
# On Fly's private network this is a plaintext redis:// URL on port 6379 (NOT
# rediss://) — the WireGuard mesh already encrypts it, and the AI service reaches
# it privately, so there's no public TLS endpoint to use here.
fly secrets set \
  REDIS_URL='redis://default:<password>@fly-livetranslate-cache.upstash.io:6379' \
  CACHE_BACKEND=redis \
  --app ai-service-python
# Optional key expiry (blank = no expiry, the default):
# fly secrets set CACHE_TTL_SECONDS=604800 --app ai-service-python
```

> The gateway gets **no** `REDIS_URL` (it never touches the cache), except for the
> optional shared rate limiter in C4 below.

---

## C2 — Multi-region: add sjc to both apps

`fly.toml` already sets `min_machines_running = 1`, which keeps **one machine warm in
the primary region (`iad`)** on each app so the hot path never pays a cold start. Fly
applies that floor to the primary region only, so `sjc` scales to 0 when idle.

After deploying the new images (C3), place a machine in `sjc` on each app.

> ⚠️ **Do not use `fly scale count 2 --region iad,sjc`.** It sets the *group total*
> to 2 and treats the region list as merely eligible, so it packs both machines into
> the primary (`iad`) and leaves `sjc` empty — verify with `fly scale show`. Clone an
> existing `iad` machine into `sjc` instead; it copies the machine's config and secrets
> deterministically:

```bash
# Grab a started machine ID per app from `fly machines list`, then clone it to sjc:
fly machine clone <iad-machine-id> --region sjc --app ai-service-python
fly machine clone <iad-machine-id> --region sjc --app matteopilotto-livetranslate-gw

# Confirm each app now reports iad + sjc (not iad only):
fly scale show --app ai-service-python
fly scale show --app matteopilotto-livetranslate-gw
```

The cloned `sjc` machines inherit `auto_stop_machines = 'stop'`, and `min_machines_running`
pins the primary region only, so `sjc` correctly scales to 0 when idle.

No gateway code change is needed: `AI_SERVICE_URL=http://ai-service-python.flycast`
is region-aware and Flycast routes each gateway machine to the nearest healthy AI
machine.

**Tradeoff:** `iad` stays warm (cost of ~1 always-on machine per app) for latency;
`sjc` at min 0 pays a one-time cold start on the first request after an idle period.

---

## C3 — Deploy order

Ship the code image first, then attach Redis, then scale out:

```bash
# 1. Deploy the current images (Workstream B pluggable-cache code is already merged).
fly deploy --app ai-service-python
fly deploy --app matteopilotto-livetranslate-gw

# 2. Set Redis secrets on the AI service (C1) — triggers a rolling restart.
#    (safe to run before step 1 too; either order works.)

# 3. Add an sjc machine to each app by cloning an iad machine (C2 — do NOT use
#    `fly scale count … --region iad,sjc`, which packs both into iad).
fly machine clone <iad-machine-id> --region sjc --app ai-service-python
fly machine clone <iad-machine-id> --region sjc --app matteopilotto-livetranslate-gw
```

---

## C4 — (Optional) Shared rate limiter

The gateway limiter uses an in-memory `MemoryStore`
([gateway-node/server.js:59](gateway-node/server.js#L59)), so multi-region makes it
**per-machine** — the effective global limit is `120 req/min × machine count`. If exact
global limiting matters, back it with `rate-limit-redis` against the same Upstash
instance:

```bash
fly secrets set REDIS_URL='redis://…' --app matteopilotto-livetranslate-gw   # same private URL
# then wire rate-limit-redis into server.js as the limiter store.
```

Otherwise leave it as-is and accept the per-machine caveat (documented here and in the
plan's risks).

---

## Verify (run, don't eyeball)

```bash
# Health from the public gateway (Anycast answers from the nearest region).
curl -sf https://matteopilotto-livetranslate-gw.fly.dev/health

# Machines are actually in both regions.
fly status --app ai-service-python
fly status --app matteopilotto-livetranslate-gw

# SLA benchmark from a US client — expect improved hit p95 + throughput.
python benchmark/bench.py \
  --target https://matteopilotto-livetranslate-gw.fly.dev \
  --json benchmark/_bench.json

# Cache persists across a redeploy (shared Redis, not ephemeral SQLite):
#   redeploy, then confirm Redis DBSIZE > 0 (or /stats db_hits > 0 on a warm key).
fly redis status livetranslate-cache
```

**Caveats** (see the plan's Risks section): `/stats` hit-rate counters are per-machine
(cache *content* is shared via Redis, counters are not); `sjc` pays a one-time cold
start when idle; and the rate limiter is per-machine unless C4 is applied.
