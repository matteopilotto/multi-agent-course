# Plan: Integrate OpenRouter + vLLM/RunPod into the AI backend

## Context

The Python AI service ([backend/ai-service-python/](../../backend/ai-service-python/)) is
hard-wired to Anthropic. All provider coupling lives in one ~55-line file,
[lib/llm.py](../../backend/ai-service-python/lib/llm.py): it builds an `AsyncAnthropic`
client, passes the prompt as a top-level `system=` param, and parses the
Anthropic-specific `msg.content[0].text` response shape.

We want to **swap LLM providers without touching `app.py` or the cache**, and specifically
to be able to call:
- **OpenRouter** — one API, many models (Claude, GPT, Gemini, Llama, etc.), OpenAI-compatible.
- **An open-source model served by vLLM on RunPod** — also exposes an OpenAI-compatible
  `/v1` endpoint.

**Consolidated approach (per user): route *everything* through the OpenAI-compatible wire
format — including Anthropic, via OpenRouter.** We drop the native Anthropic SDK entirely.
This means one client, one request shape, one response-parsing path. Switching between Claude,
GPT, Gemini, Llama, or a self-hosted open-source model becomes purely a matter of
`base_url` + `api_key` + `MODEL` — no per-provider branches to write or maintain. Outcome:
flip a couple of env vars to route translations through any OpenRouter model or a RunPod
vLLM box.

Decisions confirmed with the user:
- **Consolidate on the OpenAI SDK.** No native Anthropic path; Anthropic models are reached
  through OpenRouter like any other vendor. One code path.
- **Fold the model into the cache key** so swapping providers/models no longer serves stale
  cross-model translations.

## The seam

`app.py` imports exactly one thing from the LLM layer:
`from lib.llm import translate_text`, and calls it as
`translate_text(text, target, model=MODEL)` → `str` (async, fail-loud). We preserve that
signature. Everything else changes behind it.

---

## Changes

### 1. `lib/llm.py` — single OpenAI-compatible client (main change)

Replace the Anthropic client with one `AsyncOpenAI` client whose `base_url`/`api_key` are
env-selected. Keep the public async signature `translate_text(text, target, model) -> str`
and the **fail-loud** contract (do not catch provider errors; let them propagate so `app.py`
returns 502).

Config (read via `os.getenv`, consistent with the existing style — no pydantic-settings):

```python
PROVIDER = os.getenv("LLM_PROVIDER", "openrouter").lower()   # openrouter | vllm
MODEL_DEFAULT = os.getenv("MODEL", "anthropic/claude-sonnet-4.6")   # OpenRouter slug
```

Both providers are OpenAI-compatible; `PROVIDER` only picks the base_url + key source:

| `LLM_PROVIDER` | base_url | api_key env | `MODEL` format |
|---|---|---|---|
| `openrouter` (default) | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | vendor slug, e.g. `anthropic/claude-sonnet-4.6`, `openai/gpt-4o-mini`, `google/gemini-2.0-flash`, `meta-llama/llama-3.1-70b-instruct` |
| `vllm` | `VLLM_BASE_URL` (RunPod pod `.../v1`) | `VLLM_API_KEY` (default `"EMPTY"`) | the served model id, e.g. `meta-llama/Meta-Llama-3.1-8B-Instruct` |

Lazy singleton (keep the existing `_get_client()` pattern so `load_dotenv()` in `app.py`
runs first):

```python
from openai import AsyncOpenAI

_client: AsyncOpenAI | None = None

def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        if PROVIDER == "openrouter":
            _client = AsyncOpenAI(
                base_url="https://openrouter.ai/api/v1",
                api_key=os.getenv("OPENROUTER_API_KEY"),
            )
        elif PROVIDER == "vllm":
            _client = AsyncOpenAI(
                base_url=os.getenv("VLLM_BASE_URL"),
                api_key=os.getenv("VLLM_API_KEY", "EMPTY"),  # vLLM often ignores the key
            )
        else:
            raise ValueError(f"Unknown LLM_PROVIDER: {PROVIDER!r}")
    return _client
```

Single request/response path (system prompt as a `role:"system"` message; parse
`choices[0].message.content`):

```python
async def translate_text(text: str, target: str = "es-MX", model: str = MODEL_DEFAULT) -> str:
    resp = await _get_client().chat.completions.create(
        model=model,
        max_tokens=1024,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
    )
    return resp.choices[0].message.content.strip()
```

Keep `SYSTEM_PROMPT` unchanged. Update the module docstring (it currently says "Provider is
your choice / default is Anthropic") to describe the OpenRouter-first, OpenAI-compatible
design, and keep the FAIL-LOUD note. (Out of scope, flagging only: `target` is threaded
through the stack but the prompt hardcodes `es-MX`; if open-source models need other targets,
fold `target` into the prompt.)

### 2. `lib/cache.py` — fold model into the cache key

Today `_key()` hashes `f"{target}::{text}"`. Add `model` so provider/model swaps produce
cache misses instead of serving another model's output.

- Change `_key(text, target, model)` → `sha256(f"{model}::{target}::{text}")`.
- `set()` already receives `model=` — pass it into `_key()`.
- `get()` does **not** currently take `model` — add a `model` parameter and thread it into
  `_key()`.

### 3. `app.py` — pass model to `cache.get`

In `translate_one()` ([app.py:68](../../backend/ai-service-python/app.py#L68)), the only
caller change: `cache.get(text, target)` → `cache.get(text, target, model=MODEL)`.
`cache.set(...)` already passes `model=MODEL`. Also update the default `MODEL` fallback in
[app.py:31](../../backend/ai-service-python/app.py#L31) to match `lib/llm.py`'s new default
(an OpenRouter slug) so `/health` and cache keys stay consistent. No other `app.py` changes.

### 4. `requirements.txt` — switch the SDK

Uncomment / add `openai==1.51.0`. Remove (or comment out) `anthropic==0.116.0` since it's no
longer imported. `google-genai` stays commented — Gemini is reached through OpenRouter now.

### 5. `.env.example` — document the new knobs

Replace the "pick ONE provider" block with the OpenRouter-first setup:

```
# Provider selector: openrouter (default) | vllm  — both OpenAI-compatible
LLM_PROVIDER=openrouter

# --- openrouter (default): one API for Claude, GPT, Gemini, Llama, ... ---
OPENROUTER_API_KEY=sk-or-...
# MODEL uses OpenRouter's vendor/model slugs:
#   anthropic/claude-sonnet-4.6 | openai/gpt-4o-mini | google/gemini-2.0-flash | meta-llama/llama-3.1-70b-instruct
MODEL=anthropic/claude-sonnet-4.6

# --- vllm on RunPod (open-source model, OpenAI-compatible) ---
# LLM_PROVIDER=vllm
# VLLM_BASE_URL=https://<pod-id>-8000.proxy.runpod.net/v1
# VLLM_API_KEY=EMPTY
# MODEL=<the model id vLLM is serving, e.g. meta-llama/Meta-Llama-3.1-8B-Instruct>

TRANSLATION_DB_PATH=translations.db
BATCH_CONCURRENCY=8
```

> Verify the exact OpenRouter slug for the Claude model on
> https://openrouter.ai/models before committing the default (slugs are versioned).

---

## Files touched

- [lib/llm.py](../../backend/ai-service-python/lib/llm.py) — single `AsyncOpenAI` client (main).
- [lib/cache.py](../../backend/ai-service-python/lib/cache.py) — add `model` to `_key`/`get`.
- [app.py](../../backend/ai-service-python/app.py) — pass `model` to `cache.get`; update MODEL default.
- [requirements.txt](../../backend/ai-service-python/requirements.txt) — `openai==1.51.0` in, `anthropic` out.
- [.env.example](../../backend/ai-service-python/.env.example) — document new vars.

`lib/logger.py`, `Dockerfile`, `fly.toml` untouched.

---

## Verification

Run from `backend/ai-service-python/` with the venv active (`pip install -r requirements.txt`
to pull `openai`). `/health` returns `model`, and `/translate` responses include `cached`, so
each provider is easy to confirm.

1. **OpenRouter path (default).** `LLM_PROVIDER=openrouter`, set `OPENROUTER_API_KEY`,
   `MODEL=anthropic/claude-sonnet-4.6`. Start `uvicorn app:app --port 8000`; then
   `curl -s localhost:8000/translate -X POST -H 'content-type: application/json' -d '{"text":"The drill costs $49.99"}'`
   → expect an es-MX translation, `"cached": false` first call, `true` on repeat. `/health`
   shows the model.
2. **Provider swap via env only.** Change `MODEL` to `openai/gpt-4o-mini` (and/or
   `google/gemini-2.0-flash`), restart, repeat the curl → still a valid translation, no code
   change. Confirms the single code path works across vendors.
3. **Cache key includes model.** Because the key now folds in `model`, switching `MODEL`
   re-translates (miss) instead of returning the prior model's text. Confirm via the `cached`
   flag and `/stats`.
4. **vLLM/RunPod path.** Spin up a vLLM OpenAI server on RunPod (`--served-model-name ...`),
   set `LLM_PROVIDER=vllm`, `VLLM_BASE_URL=https://<pod>-8000.proxy.runpod.net/v1`,
   `VLLM_API_KEY=EMPTY`, `MODEL=<served id>`. Restart, repeat the curl → translation from the
   open-source model. If RunPod isn't available, smoke-test against a local `vllm serve` or
   any OpenAI-compatible mock on `localhost`.
5. **Fail-loud intact.** Point at a bad base_url or key → the endpoint returns HTTP 502
   (exception propagates, not swallowed), matching the existing contract.
6. **Batch + regression.** `POST /translate/batch` with a few strings still returns
   `{results, latencyMs}` and dedups. If the eval/benchmark harness ([eval/](../../eval/),
   [benchmark/](../../benchmark/)) is used, run it against the OpenRouter Claude model to
   compare against the prior baseline, then optionally against a vLLM model.
