"""
FDE · Assignment 1 · Python AI Service  (this is the real assignment)
=====================================================================
A small FastAPI service that translates English → Mexican Spanish with:
  - an LLM call            (lib/llm.py)
  - a two-tier cache       (lib/cache.py)  — memory + SQLite
  - structured logging     (lib/logger.py) — provided, wired for you

The Node gateway forwards the browser's requests here. You implement the
TODOs so the widget lights up. Run:

    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env          # then add your API key
    uvicorn app:app --reload --port 8000
"""
import asyncio
import os
import time

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from pydantic import BaseModel

from lib.cache import TwoTierCache
from lib.llm import translate_text
from lib.logger import get_logger

load_dotenv()

MODEL = os.getenv("MODEL", "anthropic/claude-sonnet-4.6")
DB_PATH = os.getenv("TRANSLATION_DB_PATH", "translations.db")
BATCH_CONCURRENCY = int(os.getenv("BATCH_CONCURRENCY", "8"))

app = FastAPI(title="FDE Live Translate — AI Service")
log = get_logger("ai-service")
cache = TwoTierCache(DB_PATH)

# request/response shapes ----------------------------------------------------
class TranslateIn(BaseModel):
    text: str
    target: str = "es-MX"

class BatchIn(BaseModel):
    texts: list[str]
    target: str = "es-MX"


@app.on_event("startup")
async def startup():
    # Picks the persistent tier from CACHE_BACKEND (sqlite|redis). On a Redis
    # connect failure this raises and startup fails loud (no silent fallback).
    await cache.init()
    log.info(
        "ai_service_started",
        extra={"model": MODEL, "cacheBackend": cache.backend, "db": DB_PATH},
    )


# --- core: translate one string --------------------------------------------
async def translate_one(text: str, target: str) -> dict:
    """Translate a single string, using the cache first.

    Returns a dict shaped exactly like the widget expects:
        {"translated": str, "cached": bool, "latencyMs": int, "model": str}
    """
    text = (text or "").strip()
    if not text:
        return {"translated": "", "cached": False, "latencyMs": 0, "model": MODEL}

    t0 = time.perf_counter()

    cached_value = await cache.get(text, target, model=MODEL)
    if cached_value is not None:
        latency_ms = int((time.perf_counter() - t0) * 1000)
        return {"translated": cached_value, "cached": True, "latencyMs": latency_ms, "model": MODEL}

    translated = await translate_text(text, target, model=MODEL)
    await cache.set(text, target, translated, model=MODEL)
    latency_ms = int((time.perf_counter() - t0) * 1000)
    return {"translated": translated, "cached": False, "latencyMs": latency_ms, "model": MODEL}


@app.post("/translate")
async def translate(body: TranslateIn, request: Request):
    request_id = request.headers.get("x-request-id")
    result = await translate_one(body.text, body.target)
    log.info(
        "translate",
        extra={
            "cached": result["cached"],
            "latencyMs": result["latencyMs"],
            "chars": len(body.text),
            "requestId": request_id,
        },
    )
    return result


@app.post("/translate/batch")
async def translate_batch(body: BatchIn, request: Request):
    request_id = request.headers.get("x-request-id")
    t0 = time.perf_counter()

    sem = asyncio.Semaphore(BATCH_CONCURRENCY)

    async def guarded(text: str) -> dict:
        async with sem:
            return await translate_one(text, body.target)

    # keys in original order; dedup on the stripped form (cache-key semantics)
    keys = [(t or "").strip() for t in body.texts]
    rep: dict[str, str] = {}
    for t in body.texts:
        rep.setdefault((t or "").strip(), t)
    unique_keys = list(rep.keys())

    # concurrent, bounded; any provider error propagates -> 502 (fail loud)
    done = await asyncio.gather(*(guarded(rep[k]) for k in unique_keys))
    by_key = dict(zip(unique_keys, done))

    # fan back out in original order; mark 2nd+ occurrences of a key as a hit
    results, seen = [], set()
    for k in keys:
        r = by_key[k]
        if k in seen:
            r = {**r, "cached": True}  # duplicate within batch == effectively cached
        else:
            seen.add(k)
        results.append(r)

    latency = int((time.perf_counter() - t0) * 1000)
    hits = sum(1 for r in results if r["cached"])
    log.info(
        "translate_batch",
        extra={"count": len(results), "hits": hits, "latencyMs": latency, "requestId": request_id},
    )
    # widget expects {results: [{translated, cached}], latencyMs}
    return {"results": [{"translated": r["translated"], "cached": r["cached"]} for r in results], "latencyMs": latency}


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL, "cacheSize": await cache.size()}


@app.get("/stats")
async def stats():
    return await cache.stats()
