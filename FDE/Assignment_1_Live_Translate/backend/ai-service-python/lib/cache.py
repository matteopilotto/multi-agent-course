"""
lib/cache.py — two-tier cache: memory (L1) + pluggable persistent tier (L2)
==========================================================================
Why two tiers?
  - MEMORY (dict): instant, but lost on restart, and per-process.
  - PERSISTENT (SQLite on disk *or* Redis): survives restarts, and — with Redis —
    is *shared* across machines. Check memory first, then the persistent tier,
    then the LLM.

The L2 tier is pluggable, selected by the CACHE_BACKEND env var:
  - CACHE_BACKEND=sqlite  (default) — local file, "survives restart" on one machine.
  - CACHE_BACKEND=redis            — shared, persistent, multi-region friendly.

Both tiers share the same async interface (`init/get/set/size`) and the same
`_key`, so keys are portable across tiers and switching is purely config.

The cache key must be deterministic for the same (text, target, model), so
switching providers/models produces a cache miss instead of serving another
model's stale output. Hashing the input with sha256 gives you a compact,
collision-safe key.

NOTE: `_stats` counters live on `TwoTierCache` and are therefore **per-process**.
In a multi-region deployment the cache *content* is shared (via Redis), but each
machine keeps its own hit/miss counters — so `/stats` hit-rate is per-machine.
"""
import hashlib
import os

import aiosqlite


def _key(text: str, target: str, model: str) -> str:
    return hashlib.sha256(f"{model}::{target}::{text}".encode("utf-8")).hexdigest()


# --- persistent tiers -------------------------------------------------------
class SqliteTier:
    """Disk-backed L2 tier. Verbatim logic from the original TwoTierCache."""

    def __init__(self, db_path: str):
        self.db_path = db_path

    async def init(self) -> None:
        """Create the translations table if it doesn't exist."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS translations(
                    key TEXT PRIMARY KEY,
                    source TEXT,
                    target TEXT,
                    translated TEXT,
                    model TEXT,
                    access_count INTEGER DEFAULT 1,
                    created_at TIMESTAMP
                )
                """
            )
            await db.execute(
                "CREATE INDEX IF NOT EXISTS idx_translations_key ON translations(key)"
            )
            await db.commit()

    async def get(self, text: str, target: str, model: str) -> str | None:
        k = _key(text, target, model)
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute(
                "SELECT translated FROM translations WHERE key = ?", (k,)
            ) as cur:
                row = await cur.fetchone()
            if row is not None:
                await db.execute(
                    "UPDATE translations SET access_count = access_count + 1 WHERE key = ?",
                    (k,),
                )
                await db.commit()
                return row[0]
        return None

    async def set(self, text: str, target: str, translated: str, model: str) -> None:
        k = _key(text, target, model)
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                INSERT INTO translations(key, source, target, translated, model, access_count, created_at)
                VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET
                    translated = excluded.translated,
                    model = excluded.model,
                    access_count = access_count + 1
                """,
                (k, text, target, translated, model),
            )
            await db.commit()

    async def size(self) -> int:
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute("SELECT COUNT(*) FROM translations") as cur:
                row = await cur.fetchone()
                return row[0] if row else 0


class RedisTier:
    """Shared, persistent L2 tier backed by Redis (e.g. Upstash).

    The value stored is the translated string (UTF-8). Keys are the same
    sha256 `_key` used by SqliteTier, so content is portable across tiers.
    """

    def __init__(self, url: str | None, ttl_seconds: int | None = None):
        self.url = url
        self.ttl_seconds = ttl_seconds
        self._redis = None

    async def init(self) -> None:
        # FAIL LOUD: a missing/unreachable Redis is a startup error, not a
        # silent fallback — consistent with the fail-loud stance in lib/llm.py.
        if not self.url:
            raise RuntimeError("CACHE_BACKEND=redis requires REDIS_URL to be set")
        import redis.asyncio as redis  # imported lazily so sqlite users need no redis dep

        self._redis = redis.from_url(self.url, decode_responses=True)
        await self._redis.ping()

    async def get(self, text: str, target: str, model: str) -> str | None:
        return await self._redis.get(_key(text, target, model))

    async def set(self, text: str, target: str, translated: str, model: str) -> None:
        k = _key(text, target, model)
        if self.ttl_seconds:
            await self._redis.set(k, translated, ex=self.ttl_seconds)
        else:
            await self._redis.set(k, translated)

    async def size(self) -> int:
        return await self._redis.dbsize()


def _make_tier(db_path: str):
    """Select the persistent tier from CACHE_BACKEND (default: sqlite)."""
    backend = os.getenv("CACHE_BACKEND", "sqlite").lower()
    if backend == "sqlite":
        return backend, SqliteTier(db_path)
    if backend == "redis":
        ttl = os.getenv("CACHE_TTL_SECONDS")
        return backend, RedisTier(os.getenv("REDIS_URL"), ttl_seconds=int(ttl) if ttl else None)
    raise ValueError(f"Unknown CACHE_BACKEND: {backend!r} (expected 'sqlite' or 'redis')")


class TwoTierCache:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.backend, self._tier = _make_tier(db_path)
        self._mem: dict[str, str] = {}
        self._stats = {"requests": 0, "memory_hits": 0, "db_hits": 0, "misses": 0}

    async def init(self) -> None:
        """Initialize the persistent tier (create table / connect + ping)."""
        await self._tier.init()

    async def get(self, text: str, target: str, model: str) -> str | None:
        """Return a cached translation or None. Check memory, then the L2 tier."""
        self._stats["requests"] += 1
        k = _key(text, target, model)

        # 1) memory tier
        if k in self._mem:
            self._stats["memory_hits"] += 1
            return self._mem[k]

        # 2) persistent tier (SQLite or Redis)
        translated = await self._tier.get(text, target, model)
        if translated is not None:
            self._mem[k] = translated
            self._stats["db_hits"] += 1
            return translated

        self._stats["misses"] += 1
        return None

    async def set(self, text: str, target: str, translated: str, model: str) -> None:
        """Store a translation in both tiers."""
        k = _key(text, target, model)
        self._mem[k] = translated
        await self._tier.set(text, target, translated, model)

    async def size(self) -> int:
        return await self._tier.size()

    async def stats(self) -> dict:
        total = self._stats["memory_hits"] + self._stats["db_hits"] + self._stats["misses"]
        hits = self._stats["memory_hits"] + self._stats["db_hits"]
        hit_rate = round(100 * hits / total, 1) if total else 0.0
        return {**self._stats, "hit_rate_pct": hit_rate, "memory_entries": len(self._mem)}
