# Plan: Add a native `mistral` backend to the voice agent

**Scope:** Assignment 2 voice agent only. Reach Mistral via the **native Mistral API**
(`https://api.mistral.ai/v1`), not OpenRouter.

## Core idea

`pipeline/providers.py` is deliberately "one adaptor, N backends" — every backend is just a
`base_url` + `api_key` + model names on the same OpenAI-SDK code path. Mistral's native API is
OpenAI-compatible for chat + tool calling, so the **LLM stage is essentially one new `PRESETS`
entry**. The `openai` SDK is already a dependency, so **no new package is needed**.

The only real work is the two audio stages where Mistral diverges from the Groq/OpenAI
assumptions: **STT (Voxtral, not Whisper)** and **TTS (a native Voxtral TTS whose endpoint shape
is unverified)**.

## What changed since the first draft of this plan

An earlier version of this plan assumed **"Mistral has no speech synthesis."** That is **no
longer true** — Mistral now ships `voxtral-mini-tts-latest` (voice cloning from a 2–3s sample,
~90ms streaming). So the v1 decision to fall back to system voice stands, but the *reason*
changes:

- **Old reason:** Mistral can't do TTS at all.
- **Real reason (now):** Mistral *has* TTS, but neither its transcription nor its TTS endpoint is
  **confirmed OpenAI-SDK-compatible** the way its chat endpoint is. Voxtral TTS does
  voice-cloning-from-a-sample, which strongly implies a different request/response shape than
  OpenAI's `client.audio.speech.create(voice=..., response_format="wav")`. So v1 ships with
  system voice and treats native Voxtral TTS as a **verified fast-follow**, not an impossibility.

## Confirmed facts (current Mistral API)

| Stage      | Model id                                            | OpenAI-SDK path reuse?                                                                 |
|------------|-----------------------------------------------------|---------------------------------------------------------------------------------------|
| LLM / tools| `mistral-large-latest` (flagship), `mistral-small-latest` (faster/cheaper) | **Confident** — chat completions are OpenAI-compatible incl. tool calling. Solid core. |
| STT        | `voxtral-mini-latest`                               | **Likely** via `/audio/transcriptions`, but `response_format="text"` + Whisper-style `prompt` are **unverified** → 10-min spike. |
| TTS        | `voxtral-mini-tts-latest`                           | **Exists**, but `/audio/speech` compatibility + response format **unverified** → v1 uses system voice; native TTS is a fast-follow. |

## The preset

```python
"mistral": {
    "base_url": "https://api.mistral.ai/v1",
    "api_key_env": "MISTRAL_API_KEY",
    "llm_model": "mistral-large-latest",   # strong tool-calling; mistral-small-latest for lower latency
    "stt_model": "voxtral-mini-latest",
    "tts_model": None,                      # native Voxtral TTS not wired in v1 (endpoint shape unverified)
    "tts_voice": None,
    "tts_backend": "system",               # force local voice output
},
```

## Design decisions

### 1. TTS — force system voice in v1

A `Provider` currently uses one client for all three stages, so the Mistral preset can't do cloud
TTS until the Voxtral TTS endpoint shape is verified. Minimal fix: give presets an optional
`tts_backend` default and have the Mistral preset force `"system"` (local `say`) so voice still
comes out at zero cost.

- Change `self.tts_backend = os.getenv("TTS_BACKEND", "provider")` →
  `os.getenv("TTS_BACKEND", p.get("tts_backend", "provider"))`. The existing groq/openai presets
  omit the key, so they still default to `"provider"` — behavior unchanged.
- Add a guard in `synthesize()`: if `tts_backend == "provider"` but `tts_model is None`, raise a
  clear *"This provider has no cloud TTS wired — set `TTS_BACKEND=system`"* error instead of a
  confusing 404.
- **Not built in v1:** allowing the LLM provider ≠ TTS provider (a Mistral brain paired with
  Groq/OpenAI TTS) is a larger refactor (two clients per Provider); leave it out.

### 2. STT — Voxtral, needs a verification spike

Mistral's transcription is `voxtral-mini-latest`, presumably on the same `/audio/transcriptions`
endpoint, so `Provider.transcribe()` *probably* works unchanged via the OpenAI SDK — but two
params are uncertain and must be verified against a live key before trusting them:

- `response_format="text"`
- the Whisper-style `prompt` (our `stt_prompt` hotel vocabulary)

If `prompt` isn't accepted, make it conditional / skip it for Mistral. This is a ~10-minute spike,
not a guess to bake into the plan.

## Steps (each = one small commit, on a new branch off `main`)

1. **Add the `mistral` preset + `tts_backend` preset-default plumbing** in `pipeline/providers.py`
   (preset dict, the `tts_backend` read change, and the `synthesize()` guard).
2. **STT verification spike** → then either confirm `transcribe()` works as-is or make the
   `stt_prompt` conditional for Mistral. Commit whatever adjustment the spike proves necessary.
   (Needs a live `MISTRAL_API_KEY`; if unavailable, ship steps 1/3/4 and leave this pending.)
3. **Config + docs**: add `MISTRAL_API_KEY` and Mistral defaults/caveats to
   `pipeline/config.example.env` (incl. `mistral` in the `PROVIDER=` comment and the
   `TTS_BACKEND=system` caveat); update the module docstring in `providers.py`
   ("two backends" → three), the `voice_loop.py` header comment, and the TTS caveat in `README.md`.
4. **Test**: add a unit test asserting the `mistral` preset builds a client with the right
   `base_url`/`llm_model` and that `tts_backend` defaults to `system` (mirroring the existing
   `ProviderConfigurationTests`). No live key needed — patch the SDK client.

## What does NOT change

`agent.py` (already provider-agnostic — only calls `Provider.chat()`), `voice_loop.py` logic,
`requirements.txt`, and the Groq-specific `_repair_tool_use_failed` (Mistral won't hit that error
format — leave it; monitor for Mistral's own tool-call quirks later).

## Documented fast-follow (out of v1 scope)

Wire **native Voxtral TTS** (`voxtral-mini-tts-latest`): a ~15-min spike on the `/audio/speech`
request shape against a live key.

- If it's OpenAI-compatible → just set `tts_model`/`tts_voice` in the preset and drop the
  `tts_backend: "system"` default.
- If not → add a small Mistral-specific branch in `synthesize()` (its own request/response shape,
  likely with a voice-clone sample instead of a named `voice`).

Left out of v1 because the endpoint shape is unverified and system voice already makes the demo
work end-to-end.

## Open items to confirm during build

- **LLM default:** `mistral-large-latest` (safe tool-calling) vs `mistral-small-latest`
  (cheaper/faster). Default to `large` for tool reliability, matching the Groq-70b rationale.
- **Voxtral STT params** (the spike in step 2).
- **Voxtral TTS endpoint shape** (the fast-follow spike).

## House rules for implementation

- New branch off `main`; never commit directly to `main`.
- Small, logically scoped commits (one concern each) per the steps above.
- No `Co-Authored-By` trailer on any commit.
