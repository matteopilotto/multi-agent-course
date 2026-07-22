# Aurora Voice Agent — Local Run Report

**Date:** 2026-07-22 · **Host:** macOS (Darwin 24.6) · **Python:** 3.12.8 (`pipeline/.venv`)
**Scope:** Local text-mode cascade, live providers — **OpenAI** then **Mistral**.

## Run configuration & decisions

- **Mode:** `voice_loop.py --text` (RUNBOOK Stage 2). Text mode drives the *same* agent state, router, RAG, and tools as voice mode — only mic/STT is bypassed.
- **TTS:** overrode the repo `.env` (`TTS_BACKEND=provider`) to `TTS_BACKEND=system` with a no-op `SYSTEM_TTS_CMD=true`. This follows the README's rehearsal guidance to avoid cloud-TTS charges, keeps runs quiet/fast, and still exercises the full LLM → routing → RAG → tool cascade. Cloud TTS (incl. Mistral's Voxtral base64 path) and mic STT were therefore **not** exercised here.
- **Telemetry:** per-provider JSONL under `logs/`, default redaction (`TELEMETRY_INCLUDE_CONTENT=false`).
- The repo `.env` was **not** modified; provider/TTS were overridden per-run via env vars.

## Preflight (offline, free) — ✅

| Check | Result |
|---|---|
| `python smoke_test.py` | **PASS** (availability → booking → transfer → hangup) |
| `python -m unittest -v test_features.py` | **OK — 18/18** (provider config, retrieval, router, telemetry, scale) |

---

## Run 1 — 10-turn multi-capability script

**Script (identical for both providers):** room request → book w/ name → weather (guardrail) → cancellation policy (RAG) → "speak Spanish" → pet policy in Spanish (RAG after switch) → "switch back to English" → "¡Gracias!" → check-in time → goodbye.

### OpenAI — `gpt-4o-mini` — ✅ all 10 turns

| # | Turn | Lang | Tool called | Forced route | Grounding source | Action |
|---|------|------|-------------|--------------|------------------|--------|
| 1 | room request | en | `check_availability` | — | — | — |
| 2 | book w/ name | en | — | — | — | — |
| 3 | weather | en | — (guardrail redirect) | — | — | — |
| 4 | cancellation | en | `search_hotel_knowledge` | ✔ | `#Cancellation` | — |
| 5 | speak Spanish | es | `set_language` | — | — | lang_changed |
| 6 | pet policy (ES) | es | `search_hotel_knowledge` | ✔ | `#Pets` | — |
| 7 | back to English | en | `set_language` | — | — | lang_changed |
| 8 | ¡Gracias! | en | — (stayed EN ✓) | — | — | — |
| 9 | check-in | en | `search_hotel_knowledge` | ✔ | `#Check-In And Check-Out` | — |
| 10 | goodbye | en | `end_call` | — | — | **hangup** (SIP BYE) |

**Latency:** min 960 / mean 2115 / max 4062 ms per turn (LLM mean 2103 ms; routing/retrieval/tools all ≤1 ms).

### Mistral — `mistral-large-latest` — ✅ all 10 turns

| # | Turn | Lang | Tool called | Forced route | Grounding source | Action |
|---|------|------|-------------|--------------|------------------|--------|
| 1 | room request | en | — (asked room type first) | — | — | — |
| 2 | book w/ name | en | — | — | — | — |
| 3 | weather | en | — (guardrail redirect) | — | — | — |
| 4 | cancellation | en | `search_hotel_knowledge` | ✔ | `#Cancellation`,`#Pets` | — |
| 5 | speak Spanish | es | `set_language` | — | — | lang_changed |
| 6 | pet policy (ES) | es | `search_hotel_knowledge` | ✔ | `#Pets` | — |
| 7 | back to English | en | `set_language` | — | — | lang_changed |
| 8 | ¡Gracias! | en | `check_availability` | — | — | — |
| 9 | check-in | en | `search_hotel_knowledge` | ✔ | `#Check-In…`,`#Cancellation`,`#Pets` | — |
| 10 | goodbye | en | `end_call` | — | — | **hangup** (SIP BYE) |

**Latency:** min 1139 / mean 2209 / max 3188 ms per turn (LLM mean 2199 ms) — slightly higher mean than `gpt-4o-mini` but a tighter spread.

---

## Run 2 — booking completion (follow-up)

In Run 1 neither model created the reservation on the multi-capability script — both chose to ask for a room-type preference first, so no confirmation ID was generated. This follow-up used an explicit room type + name/email to drive `create_booking` end-to-end.

**Script:** `"I need a Standard Queen … Aug 12–14 for two guests."` → `"Yes, book the Standard Queen for Priya Shah at priya@example.com."` → `"goodbye"`.

| Provider | t1 tool | t2 tool | Confirmation ID | t3 action |
|---|---|---|---|---|
| OpenAI `gpt-4o-mini` | `check_availability` | `create_booking` | **AH-4827** | hangup (SIP BYE) |
| Mistral `mistral-large-latest` | `check_availability` | `create_booking` | **AH-4827** | hangup (SIP BYE) |

**Evidence the ID is tool-generated, not model-invented:**
- Both providers, on separate runs, returned the *same* deterministic ID `AH-4827` from the mock `create_booking` tool.
- Telemetry shows `tool.requested | create_booking` followed by `tool.result | create_booking` on turn 2 for both; the reply text quoting `AH-4827` is produced only after the tool result.
- `create_booking` arguments show `guest_name` and `contact` as `[REDACTED]` in telemetry (sensitive-field redaction working).

---

## What the runs confirm

- **Single adapter, three-way parity.** Same agent code, tools, sources, and hangup→SIP BYE across OpenAI and Mistral's native API — the only change is the provider line.
- **Hybrid tool routing.** Every high-confidence policy turn shows `tool.route_selected` forcing `search_hotel_knowledge` *before* the first model call, with answers grounded in `hotel_policies.md#…`. Turn 4 fires correctly even after the turn-3 off-topic refusal (retrieval-forcing survives a prior guardrail).
- **Guardrails hold.** "What is the weather?" was redirected to hotel reservations on both providers, no tool call.
- **Language routing correct on both.** Explicit switches fire `set_language` + `router.language_changed`; the Spanish route persists across the pet-policy turn; **"¡Gracias!" did not flip back to Spanish** (matches `explicit_language_request()`); the final check-in answer returned in English.
- **Booking is auditable state via tool.** `create_booking` produced the mock confirmation ID; the model narrates it but does not fabricate it.
- **Telemetry & redaction (Stage 7).** Each turn carries `traceId`/`sessionId`/`turnId`, provider/model/language/locale, per-stage timings, tool args/results, sources, and action. Transcript/response content and sensitive tool fields are `[OMITTED]`/`[REDACTED]`.

## Observations & caveats

- **Date resolution differs.** Given bare month/day, OpenAI resolved to year **2023**, Mistral to **2025**. The mock `create_booking` does not validate dates, so both succeeded — a real booking tool would need date validation/normalization.
- **Conversational style differs.** `mistral-large` tends to confirm details and ask for a room type before checking availability; `gpt-4o-mini` calls `check_availability` more eagerly. Both reach the same outcomes.
- **Not exercised:** cloud TTS and mic STT (text mode + no-op system TTS by design, for cost/mic avoidance). Mistral's Voxtral base64-TTS decode path is covered by unit test `test_mistral_synthesize_decodes_base64_audio_data` (passing).

## Artifacts (git-ignored `logs/`)

- `logs/openai-run.jsonl`, `logs/mistral-run.jsonl` — Run 1 (10 turns each)
- `logs/openai-booking.jsonl`, `logs/mistral-booking.jsonl` — Run 2 (booking completion)
