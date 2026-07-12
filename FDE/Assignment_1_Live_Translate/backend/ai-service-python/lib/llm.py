"""
lib/llm.py — the LLM translation call
======================================
One job: turn an English string into Mexican Spanish using an LLM.

Everything routes through a single OpenAI-compatible client (`AsyncOpenAI`),
including Anthropic models — reached via OpenRouter like any other vendor.
This keeps one request shape and one response-parsing path; switching
providers/models is purely `LLM_PROVIDER` + `MODEL` + API key, no code change.

  - LLM_PROVIDER=openrouter (default) — https://openrouter.ai/api/v1, one API
    for Claude, GPT, Gemini, Llama, etc. MODEL uses OpenRouter's vendor/model
    slugs, e.g. anthropic/claude-sonnet-4.6, openai/gpt-5.6-terra.
  - LLM_PROVIDER=vllm — a self-hosted OpenAI-compatible endpoint (e.g. vLLM on
    RunPod). MODEL is whatever model id vLLM is serving.

FAIL LOUD: do NOT wrap the call in a try/except that returns `text` on error.
If the provider fails, let the exception propagate so the caller returns a 502.
Silently returning the untranslated input is an automatic fail on this
assignment (and a real production bug — it ships English while looking healthy).
"""
import os

from openai import AsyncOpenAI

PROVIDER = os.getenv("LLM_PROVIDER", "openrouter").lower()
MODEL_DEFAULT = os.getenv("MODEL", "anthropic/claude-sonnet-4.6")

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    # Built lazily (not at import time) so API keys are read after app.py's
    # load_dotenv() has run, regardless of import order.
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


SYSTEM_PROMPT = (
    "You are a professional translator. Translate the user's English text "
    "into natural MEXICAN Spanish (es-MX) — not generic or Castilian Spanish. "
    "Return ONLY the translation — no preamble, no notes, no wrapping quotes. "
    "Keep numbers, prices (with $), and product/model codes unchanged."
)


async def translate_text(text: str, target: str = "es-MX", model: str = MODEL_DEFAULT) -> str:
    """Return `text` translated into `target` (Mexican Spanish by default)."""
    resp = await _get_client().chat.completions.create(
        model=model,
        max_tokens=1024,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
    )
    return resp.choices[0].message.content.strip()
