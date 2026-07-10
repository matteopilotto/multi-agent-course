# Pipeline  -  Hands-On Voice Loop (Layer A + B)

The part attendees build/run live. A terminal voice agent:

```
  mic  →  VAD  →  STT  →  LLM agent (+tools)  →  TTS  →  speakers
```

No phone, no SIP  -  just your laptop mic. Telephony is covered by `../mocks/`.

## Provider: one adaptor, three modes

`providers.py` keeps mock, OpenAI, and Groq behind the same interface. You switch
backends by flipping one line in `.env`; model names default sensibly per provider.

| Mode | Needs | Use it for |
|------|-------|------------|
| `mock` | No key, network, or SDK | Rehearsal, tests, and no-cost fallback |
| `openai` | OpenAI key | Current live demo path |
| `groq` | Groq key | Alternate low-cost provider |

Recommended for rehearsal:

```env
PROVIDER=openai
OPENAI_API_KEY=your_key_here
TTS_BACKEND=system
```

`TTS_BACKEND=system` uses your laptop voice command, so you avoid cloud TTS cost and
keep the demo moving if provider audio has latency or quota issues.

For a more natural OpenAI voice, use:

```env
TTS_BACKEND=provider
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=marin
TTS_INSTRUCTIONS=Speak warmly and naturally, like a calm support representative.
```

> Avoid the OpenAI **Realtime** API for this  -  it's ~10–20× the price. The pipeline here keeps
> STT/LLM/TTS separate, which is both cheaper *and* what you want pedagogically (each stage is
> visible and individually timed).

## Setup (send to attendees the day before)

```bash
cd voice-agent-workshop/pipeline
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.example.env .env      # set PROVIDER + the matching API key
```

- Use an OpenAI key with `PROVIDER=openai` and `OPENAI_API_KEY`.
- Groq is also supported as an alternate provider with `PROVIDER=groq` and `GROQ_API_KEY`.
- `sounddevice` needs PortAudio: `brew install portaudio` if the import fails.

## Test it with no network (offline mock)

`PROVIDER=mock` returns scripted STT/LLM/TTS with **no key,
no network, and no SDK installed**  -  the same interface as OpenAI/Groq, so it exercises the
real loop and tool calls. Use it for rehearsals, CI, or a projector that has no internet.

```bash
python smoke_test.py                    # asserted offline end-to-end (tools + actions)
PROVIDER=mock python voice_loop.py --text   # play with it interactively, offline
```

`smoke_test.py` drives scripted turns through the real `Agent` and checks the
hotel-booking guardrail, availability lookup, booking confirmation, transfer,
and hangup paths. Green here means the wiring is correct before you ever add a key.

## Run

```bash
python voice_loop.py          # real mic (VAD endpointing + STT + TTS)
python voice_loop.py --text   # type your turn  -  needs NO audio libs, NO mic
```

`--text` mode still uses the real LLM + tools over your chosen provider, so it's the
always-works fallback when someone's mic or PortAudio misbehaves. Each turn prints a
per-stage latency breakdown (stt / llm+tools / tts) against the ~800 ms target.

## Files

| File | Role |
|------|------|
| `providers.py` | The adaptor  -  mock plus OpenAI/Groq via the OpenAI SDK. `chat` / `transcribe` / `synthesize`. |
| `agent.py` | The brain  -  system prompt + hotel tools (`check_availability`, `create_booking`, `transfer_to_human`, `end_call`) via OpenAI-style tool calling. |
| `voice_loop.py` | The loop  -  VAD endpointing, STT, agent turn, TTS playback, latency timing, `--text` mode. |

Try: *"I need a room from August 12 to August 14 for two guests."* → watch
`check_availability` fire and the agent offer room options. Then say
*"Book it for Priya Shah at priya@example.com."* → `create_booking` returns a confirmation.
*"Can I talk to a person?"* → `transfer_to_human` → `[SIP REFER]`.

## What to demo at each checkpoint

1. **Layer A:** ask for a room, hear it answer. "We have a voice agent."
2. **Layer B:** "I need a room for two guests..." → `check_availability` fires in the logs.
3. **Latency:** point at the per-turn breakdown  -  the LLM and TTS stages are usually the tuning targets.
4. **Hand-off:** "Now  -  how does a real phone call get here?" → open `../mocks/`.

## Budget check
Mock mode and local LiveKit are **$0**. With OpenAI plus `TTS_BACKEND=system`, the live
pipeline should stay very low for a short workshop demo because the paid calls are STT and
LLM only. Use provider TTS only for the final polished run.
