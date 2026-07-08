# Voice Agent Benchmark — Cascade vs. Speech-to-Speech

A 10-query benchmark comparing two voice architectures on the **same** customer-support agent:

- **Cascade** — STT (Gemini flash-lite) → sanitize → A2A Judge → ADK agent (+MCP tools, Mem0) → TTS
- **Speech-to-Speech (S2S)** — Gemini Live / native audio, tools wired in via function calling

> **Masking is disabled for this benchmark.** The A2A Masker stage is turned off, so no PII-masking
> assertions are made. Guardrail testing here is limited to input-side blocking (sanitizer +
> A2A Judge) and the agent's own data-isolation rule.

## What we measure

| Dimension | How |
|:----------|:----|
| **Latency** | Per-stage timings + time-to-first-audio (cascade emits these already); wall-clock for S2S |
| **Cost** | Tokens → $/turn from Phoenix (cascade) / usage metadata (S2S), decomposed by stage |
| **Agentic capability** | Trajectory (right tool, right args, right sequence, no forbidden tool) + outcome (facts match DB, task success) + STT word-error-rate |
| **Control / observability** | Do the input guardrails fire? Is a transcript exposed? (This is where cascade wins.) |

## Files

- [`manifest.json`](manifest.json) — machine-readable ground truth for the harness (one entry per query, now including `audio` paths + durations).
- [`queries.md`](queries.md) — human-readable spec for all 15 queries (what to say, expected tools, ground truth, rationale).
- [`convert_audio.py`](convert_audio.py) — normalizes the raw audio into the format the cascade STT expects (reproducible).
- `audio/qNN.wav` — the **ready** benchmark clips: `q01.wav` … `q15.wav`, **16 kHz mono PCM16**, aligned to the manifest ids.
- `audio/source_mp3/qNN.mp3` — the original provided recordings (48 kHz MP3), preserved for provenance.

## Audio dataset (ready to use)

The 15 clips in `audio/` are the finalized inputs — one per query, named `qNN.wav` so the id
matches `manifest.json`. Each `source_text` is the **WER ground truth** for that clip and must
stay untouched.

The originals were 48 kHz MP3s mislabeled `.wav`; the cascade STT
([`cs_agent/voice/stt.py`](../advance-customer-support-agent-feature-A2A-MCP-ADK/cs_agent/voice/stt.py))
wants **raw 16-bit PCM @ 16 kHz mono**. `convert_audio.py` decoded, downmixed, and resampled
them, wrote real PCM16 WAVs, and kept the originals under `audio/source_mp3/`. To regenerate:

```bash
pip install miniaudio          # self-contained mp3 decoder, no ffmpeg needed
python convert_audio.py        # source_mp3/*.mp3 -> audio/qNN.wav + updates manifest
```

> Note: the clips were TTS'd separately from the cascade's own STT model, so WER is not biased
> by same-model self-transcription — good for the cascade-vs-S2S comparison.

## Hop definition

**Hops = number of dependent data/action tool calls on the critical path**, excluding the
always-on `search_memory`. A call counts as a second hop only when its necessity or arguments
depend on reasoning over a prior call's result (e.g. "cancel my *most recent* order" = list
orders → discover the newest ID → log the cancellation = 2 hops).

- **0 hops** — blocked or refused before any DB tool is needed.
- **1 hop** — one lookup (even if it requires multi-record math, like summing a total).
- **2 hops** — a dependent second call (an action that needs an ID discovered by the first call).

## Fairness controls (for the harness, later)

- Re-seed the DB (`./run.sh seed`) before every run so IDs and statuses are identical.
- Pin the logged-in user per query (`user` field).
- Give S2S the **same** MCP tools for a fair agentic fight.
- Run each query ≥3× per architecture; report p50/p95 and pass-rate variance, not single shots.
- Log raw runs; grade in a separate pass so you can re-grade without re-running.
