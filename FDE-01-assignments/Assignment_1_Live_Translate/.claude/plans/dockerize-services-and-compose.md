# Plan — Dockerize both services + `docker-compose.yml`

## Context

Assignment 1 (Live Translate) runs two backend services locally, each started by hand:
the **Node gateway** (`:8787`) and the **Python AI service** (`:8000`). The first stretch
goal is to containerize both and add a `docker-compose.yml` so a single
`docker compose up` boots the whole stack — matching the README's "run the whole thing
locally with one command."

Both services already have Fly.io Dockerfiles, but they are **not** compose-ready and have
real defects. This plan produces **self-contained (baked) images** and a **named volume** so
the SQLite cache survives restarts (both confirmed with the user). We leave the gateway's
existing Fly Dockerfile untouched (it builds from a different context) and reuse — after
hardening — the AI service's Fly Dockerfile.

### Key facts found during exploration
- **Gateway** (`backend/gateway-node/server.js`): listens on `PORT` (default 8787), forwards to
  `AI_SERVICE_URL` (default `http://localhost:8000`) via global `fetch` (needs Node 18+).
  It serves the widget from `path.join(__dirname, "..","..","widget","translation-widget.js")`
  — **a file outside the `gateway-node/` build context.** This is the main containerization
  snag. Its Fly Dockerfile has `EXPOSE 3000` (wrong port) and a suspicious `node:22.23.0` tag.
- **AI service** (`backend/ai-service-python/app.py`): FastAPI `app:app` on `0.0.0.0:8000`.
  Needs only `OPENROUTER_API_KEY` (not `ANTHROPIC_API_KEY`), plus `MODEL`,
  `TRANSLATION_DB_PATH` (default `translations.db`, relative → needs a volume), and
  `BATCH_CONCURRENCY`. Its `.dockerignore` is too loose — it currently bakes `.env` (secret
  leak), the 3.2 MB `*.db`, `*.log`, and 9 stray 0-byte junk files into the image.

## Approach

Work on a new branch off `main`, in small scoped commits, no `Co-Authored-By` trailer
(per `CLAUDE.md`).

### 1. Gateway image (self-contained, context = assignment root)
Because the widget lives two levels above `gateway-node/`, the gateway image must build from
the **assignment root** so the Dockerfile can copy both the gateway and the widget. With
`WORKDIR /app`, `__dirname` is `/app` and `../../widget/translation-widget.js` resolves to
`/widget/translation-widget.js` — so copying the widget to `/widget/` makes it work **with no
code change to `server.js`**.

- **New file** `backend/gateway-node/Dockerfile.compose` (referenced with `context: .` at root):
  - `FROM node:22-slim` (valid LTS tag; `engines.node >= 18`).
  - `WORKDIR /app`, `ENV NODE_ENV=production`.
  - `COPY backend/gateway-node/package.json backend/gateway-node/package-lock.json ./`
    then `RUN npm ci --omit=dev` (deps are pure JS — drop the `build-essential`/`node-gyp`
    baggage from the Fly Dockerfile).
  - `COPY backend/gateway-node/server.js ./`
  - `COPY widget/translation-widget.js /widget/translation-widget.js`  ← fixes `/widget.js`.
  - `EXPOSE 8787`; `CMD ["node","server.js"]`.
  - `HEALTHCHECK` using node (no curl in slim): `node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.
- **New file** `.dockerignore` at the assignment root (only affects the root-context gateway
  build) excluding heavy/irrelevant paths: `backend/ai-service-python/`, `**/node_modules/`,
  `**/.venv/`, `**/*.db`, `**/*.log`, `.git/`, `extension/`, `demo-pages/`, `benchmark/`,
  `diagrams/`, `eval/`, `**/.env`.
- Leave `backend/gateway-node/Dockerfile` (Fly's) as-is so `fly deploy` from that dir keeps working.

### 2. AI service image (harden the existing Dockerfile; context = its own dir)
The existing multi-stage `backend/ai-service-python/Dockerfile` is sound; make it compose- and
prod-safe (all changes are Fly-safe too):
- Add `ENV PYTHONUNBUFFERED=1` to the **final** stage so logs reach `docker compose logs`.
- Add `EXPOSE 8000`.
- Add a `HEALTHCHECK` via `python -c` + `urllib.request` against `/health`.
- **Rewrite** `backend/ai-service-python/.dockerignore` to add `.env`, `*.db`, `*.log`,
  `.git/`, and the 9 junk filenames so none are baked into the image.
- **Delete** the 9 stray 0-byte junk files (`=`, `Verified`, `exporting`, `pushing`,
  `transferring`, `resolve`, `pushin:deployment-…`, `pu1a7c5ebb9c4`, `p913e2ca…`) — leftover
  redirected build output.

### 3. `docker-compose.yml` (new, at assignment root)
Two services on a default network so the gateway reaches the AI service by service name.

- **`ai-service`**
  - `build: { context: ./backend/ai-service-python }`
  - `env_file: ./backend/ai-service-python/.env`  (supplies `OPENROUTER_API_KEY`, `MODEL`, …)
  - `environment: TRANSLATION_DB_PATH=/data/translations.db`  (override → onto the volume)
  - `volumes: [ ai-cache:/data ]`  (named volume → cache survives restart)
  - `ports: [ "8000:8000" ]`  (lets `bench.py --direct` and curl hit it directly)
  - `healthcheck` (from the Dockerfile / inline) so the gateway can wait on it.
- **`gateway`**
  - `build: { context: ., dockerfile: backend/gateway-node/Dockerfile.compose }`
  - `environment: [ AI_SERVICE_URL=http://ai-service:8000, PORT=8787 ]`  (no secrets needed)
  - `ports: [ "8787:8787" ]`
  - `depends_on: { ai-service: { condition: service_healthy } }`
- **`volumes: { ai-cache: {} }`**

### 4. README — document the one-command run
Add a **"Run with Docker Compose"** subsection (near Part 1/2 or the stretch section):
prerequisites (each service still needs its `.env`, esp. `OPENROUTER_API_KEY` in the AI
service `.env`), then:
```bash
cd FDE/Assignment_1_Live_Translate
docker compose up --build        # gateway :8787, ai-service :8000
```
Note the cache persists in the `ai-cache` volume (`docker compose down -v` to wipe it).

### Suggested commits
1. AI service: harden Dockerfile (`EXPOSE`, `PYTHONUNBUFFERED`, healthcheck), rewrite
   `.dockerignore`, remove stray junk files.
2. Gateway: add `Dockerfile.compose` + root `.dockerignore`.
3. Add `docker-compose.yml`.
4. README: Docker Compose run instructions.

## Files
- **New:** `FDE/Assignment_1_Live_Translate/docker-compose.yml`
- **New:** `FDE/Assignment_1_Live_Translate/backend/gateway-node/Dockerfile.compose`
- **New:** `FDE/Assignment_1_Live_Translate/.dockerignore`
- **Edit:** `FDE/Assignment_1_Live_Translate/backend/ai-service-python/Dockerfile`
- **Edit:** `FDE/Assignment_1_Live_Translate/backend/ai-service-python/.dockerignore`
- **Edit:** `FDE/Assignment_1_Live_Translate/README.md`
- **Delete:** the 9 stray junk files in `backend/ai-service-python/`
- **Unchanged:** `backend/gateway-node/Dockerfile`, both `fly.toml`, `server.js`, all provided assets.

## Verification (end to end)
```bash
cd FDE/Assignment_1_Live_Translate
# AI service .env must have a real OPENROUTER_API_KEY
docker compose up --build -d

# 1. both healthy
curl -sf localhost:8000/health && curl -sf localhost:8787/health

# 2. widget is served from inside the gateway image (the context fix)
curl -sf localhost:8787/widget.js | head -c 40

# 3. contract + cache: run twice → 2nd is cached:true with much lower latencyMs
curl -s localhost:8787/translate -H 'content-type: application/json' \
  -d '{"text":"Good morning, welcome!","target":"es-MX"}'
curl -s localhost:8787/translate -H 'content-type: application/json' \
  -d '{"text":"Good morning, welcome!","target":"es-MX"}'

# 4. cache survives restart (named volume): recreate AI service, repeat call → still cached:true
docker compose restart ai-service
curl -s localhost:8787/translate -H 'content-type: application/json' \
  -d '{"text":"Good morning, welcome!","target":"es-MX"}'

# 5. SLA gate still green through the composed gateway
python benchmark/bench.py

# 6. no secrets/db baked into images
docker compose run --rm ai-service sh -c 'ls -la /app/.env /app/*.db 2>&1'  # should be "No such file"

docker compose down     # (add -v to also drop the cache volume)
```
