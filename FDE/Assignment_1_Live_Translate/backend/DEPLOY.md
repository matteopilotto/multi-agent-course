# Deploy runbook — multi-region (EU + US-East) + shared Redis cache

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

**Regions:** `fra` (EU / Frankfurt, **primary — kept warm**) and `iad` (US-East,
secondary — scales to 0). The primary is where the operator/most traffic is (Europe),
so it holds the warm machine; `iad` gives US visitors a nearer machine on demand.

> **Migrating from an earlier `iad`+`sjc` (US-only) setup?** Three deltas: (1) move the
> Redis read replica `sjc → fra` (C1); (2) `primary_region` is now `fra` in both
> `fly.toml` — `fly deploy` picks it up; (3) clone an existing `iad` machine into `fra`
> (C2). You do **not** need to recreate the Redis instance — see the note in C1.

---

## C1 — Provision Upstash Redis (shared, persistent L2 cache)

Redis is the persistent cache tier (`CACHE_BACKEND=redis`). It must be reachable only
from the AI service on the private network — never from the browser or the gateway.

```bash
# Upstash-managed Redis on Fly. Primary in the warm region (fra), read replica in iad
# so US-East AI machines read locally on L2 (the in-memory L1 tier absorbs repeats too).
fly redis create --name livetranslate-cache --region fra --replica-regions iad
# Retrieve the connection string any time:
fly redis status livetranslate-cache        # shows the private redis:// URL + regions
```

> **Already created it with `iad` as primary?** Don't recreate — Upstash fixes the
> primary at create time, but you don't need to move it. Just point the read replica at
> `fra`:
> ```bash
> # --replica-regions REPLACES the replica set (it doesn't append), so pass the full list.
> fly redis update livetranslate-cache --replica-regions fra
> ```
> Cache **hits (reads)** are served from the local `fra` replica — that's what your
> hit-latency SLA measures. Only cache **misses (writes)** forward to the `iad` primary,
> and a miss already costs a ~2 s LLM call, so the cross-region write is negligible.
> Recreate with `--region fra` **only** if you also want write-locality in the EU.

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

## C2 — Multi-region: fra (warm) + iad (secondary)

`fly.toml` sets `primary_region = 'fra'` and `min_machines_running = 1`, which keeps
**one machine warm in `fra`** on each app so the EU hot path never pays a cold start.
Fly applies that floor to the primary region only, so `iad` scales to 0 when idle.

You need one machine per app in **each** of `fra` and `iad`. From a current `iad`-only
state (existing machines live in `iad`), clone one into `fra`:

> ⚠️ **Do not use `fly scale count 2 --region fra,iad`.** It sets the *group total* to 2
> and treats the region list as merely eligible, so it packs both machines into one
> region and leaves the other empty — verify with `fly scale show`. Clone across regions
> instead; a clone copies the machine's config and secrets deterministically:

```bash
# Grab a started machine ID per app from `fly machines list`, then clone it into fra:
fly machine clone <iad-machine-id> --region fra --app ai-service-python
fly machine clone <iad-machine-id> --region fra --app matteopilotto-livetranslate-gw

# Confirm each app now reports fra + iad (not a single region):
fly scale show --app ai-service-python
fly scale show --app matteopilotto-livetranslate-gw
```

After `fly deploy` applies `primary_region = 'fra'`, the `fra` machine is the warm one
and `iad` auto-stops when idle. (If you'd rather not keep a second always-idle `iad`
machine per app, trim `iad` to a single machine — one is enough for on-demand US traffic.)

No gateway code change is needed: `AI_SERVICE_URL=http://ai-service-python.flycast`
is region-aware and Flycast routes each gateway machine to the nearest healthy AI
machine.

**Tradeoff:** `fra` stays warm (cost of ~1 always-on machine per app) for EU latency;
`iad` at min 0 pays a one-time cold start on the first request after an idle period.

---

## C3 — Deploy order

```bash
# 1. Redis: create fra-primary + iad replica (fresh), OR move the replica to fra if the
#    instance already exists in iad (see C1). Set secrets on the AI service.
#      fly redis create --name livetranslate-cache --region fra --replica-regions iad
#      # or, if it already exists: fly redis update livetranslate-cache --replica-regions fra

# 2. Deploy the current images — this applies primary_region = 'fra' from fly.toml.
fly deploy --app ai-service-python
fly deploy --app matteopilotto-livetranslate-gw

# 3. Add the fra machine to each app by cloning an iad machine (C2 — do NOT use
#    `fly scale count … --region fra,iad`, which packs both into one region).
fly machine clone <iad-machine-id> --region fra --app ai-service-python
fly machine clone <iad-machine-id> --region fra --app matteopilotto-livetranslate-gw
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

# Machines are actually in both regions (expect fra + iad, not one region).
fly scale show --app ai-service-python
fly scale show --app matteopilotto-livetranslate-gw

# SLA benchmark — run it from your EU client (fra is nearest); expect improved hit
# p95 + throughput vs. the old iad-only topology.
python benchmark/bench.py \
  --target https://matteopilotto-livetranslate-gw.fly.dev \
  --json benchmark/_bench.json

# Cache persists across a redeploy (shared Redis, not ephemeral SQLite):
#   redeploy, then confirm Redis DBSIZE > 0 (or /stats db_hits > 0 on a warm key).
fly redis status livetranslate-cache
```

**Caveats** (see the plan's Risks section): `/stats` hit-rate counters are per-machine
(cache *content* is shared via Redis, counters are not); `iad` pays a one-time cold
start when idle; and the rate limiter is per-machine unless C4 is applied.
