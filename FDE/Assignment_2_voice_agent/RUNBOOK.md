# Runbook  -  Follow Along End to End

Everything you need to run this project from scratch, with the **real output of each command**
so you know exactly what "working" looks like. All the steps in **Part 1 run fully offline**.
No API key, network access, or `pip install` is required. Parts 2-3 add live speech.

> New here? Read [`README.md`](README.md) for setup, FDE framing, and the 90-minute plan.
> This file is just "type these commands, see this output."

The whole thing is one loop:

```
  you speak → STT → LLM agent (+tools) → TTS → you hear a reply
```

There are **three provider modes**, all behind the same code:

| Mode | Needs | For |
|------|-------|-----|
| `mock` | nothing (offline) | rehearsal, tests, the SIP call demo, live fallback |
| `openai` | your key | the real "talk to a bot" demo |
| `groq` | optional key | alternate low-cost provider |

---

## Prerequisites

- **Python 3.10+** (`python3 --version`).
- For **Part 1 (offline)**: nothing else.
- For **Part 3 (live)**: an OpenAI or Groq key, plus `pip install` and a mic.

---

## Directory map

```
Assignment_2_voice_agent/
├── README.md            ← the plan / concept
├── RUNBOOK.md           ← this file
├── livekit/             ← optional room/session demo
│   ├── create_room.py
│   ├── create_token.py
│   ├── talk_server.py
│   ├── start_local_server.sh
│   └── requirements.txt
├── pipeline/            ← the agent + voice loop
│   ├── providers.py     ← adaptor: groq / openai / mock
│   ├── agent.py         ← LLM + tools (availability, booking, transfer, end call)
│   ├── voice_loop.py    ← VAD→STT→LLM→TTS loop (--text mode too)
│   ├── smoke_test.py    ← offline end-to-end assertion
│   ├── requirements.txt
│   └── config.example.env
└── mocks/               ← telephony, no carrier
    ├── demo_call.py     ← full simulated inbound call (SIP→agent→SIP)
    ├── ivr_menu_mock.py ← interactive IVR menu
    └── sip-ivr-call-flow.md  ← annotated SIP/RTP reference
```

---

## Part 1  -  Run everything offline (no key, no install)

Start here. This proves the whole system works before you touch a provider.

```bash
cd voice-agent-workshop
```

### 1a. Sanity check  -  the automated end-to-end test

```bash
cd pipeline
python3 smoke_test.py
```

Expected output:

```
you>   Can you tell me the weather?
agent> I can only help with hotel reservations. Are you looking to book, change, or cancel a stay?

you>   I need a room from August 12 to August 14 for two guests.
agent> Available rooms for August 12 to August 14: Standard Queen at $189/night. Would you like me to book one of these?

you>   Yes, book it for Priya Shah at priya@example.com.
agent> Booking confirmed. Confirmation AH-4827 for Priya Shah in a Standard Queen from August 12 to August 14 for 2 guest(s). Confirmation sent to priya@example.com.

you>   Actually, connect me to a person
agent> Transferring you to the front desk.
[action: transfer]

you>   Goodbye
agent> Ending the call.
[action: hangup]

RESULT: PASS
```

`PASS` means the loop, the tool calls, and the transfer/hangup control signals are all wired
correctly. This runs the **real** `Agent`  -  only the provider is mocked.

### 1b. Talk to the agent yourself (typed, offline)

```bash
PROVIDER=mock python3 voice_loop.py --text
```

Then type `I need a room from August 12 to August 14 for two guests.` and
`can I talk to a person?`. Expected:

```
Provider: mock | LLM: mock-llm
Call started. Say/type 'goodbye' or Ctrl-C to hang up.

agent> Thanks for calling Aurora Hotel reservations. How can I help?
you> agent> Available rooms for August 12 to August 14: Standard Queen at $189/night. Would you like me to book one of these?
  ── turn latency ──
    stt               0 ms
    llm+tools         0 ms
    tts               0 ms
    TOTAL             0 ms  (target < ~800 ms)

you> agent> Transferring you to the front desk.
  ── turn latency ──
    stt               0 ms
    llm+tools         0 ms
    tts               0 ms
    TOTAL             0 ms  (target < ~800 ms)

[transferring to front desk  -  SIP REFER to front-desk]
```

(Latencies are ~0 ms because the mock is instant  -  on Groq you'll see real milliseconds here.)

### 1c. Watch a full phone call  -  SIP handshake to teardown

```bash
cd ../mocks
python3 demo_call.py
```

Expected output:

```
=== INBOUND CALL  from +15551230000  Call-ID 9c8b7a6d… ===

  SIP ◀── INVITE sip:agent@voice.demo  (from +15551230000, SDP offer: PCMU/Opus)
  SIP ──▶ 100 Trying
  SIP ──▶ 180 Ringing
  SIP ──▶ 200 OK  (SDP answer: PCMU, RTP port 40000)
  SIP ◀── ACK  → call established, media flowing

  RTP ═══▶ [agent] Thanks for calling Aurora Hotel reservations. How can I help?
  RTP ◀═══ [caller] Hi, I need a room from August 12 to August 14 for two guests.
        │ VAD: endpoint detected → STT → agent
  RTP ═══▶ [agent] Available rooms for August 12 to August 14: Standard Queen at $189/night. Would you like me to book one of these?
  RTP ◀═══ [caller] Yes, book it for Priya Shah at priya@example.com.
        │ VAD: endpoint detected → STT → agent
  RTP ═══▶ [agent] Booking confirmed. Confirmation AH-4827 for Priya Shah in a Standard Queen from August 12 to August 14 for 2 guest(s). Confirmation sent to priya@example.com.
  RTP ◀═══ [caller] Great, thanks. That's all, goodbye.
        │ VAD: endpoint detected → STT → agent
  RTP ═══▶ [agent] Ending the call.
        │ tool action: hangup

  SIP ◀── BYE  (caller hung up)
  SIP ──▶ 200 OK  → media stops

  [call ended] transcript saved · duration logged · 2 caller turns
```

Now the transfer-to-human variant:

```bash
python3 demo_call.py --transfer
```

Expected output (ends in a SIP REFER instead of BYE):

```
=== INBOUND CALL  from +15551230000  Call-ID 9c8b7a6d… ===

  SIP ◀── INVITE sip:agent@voice.demo  (from +15551230000, SDP offer: PCMU/Opus)
  SIP ──▶ 100 Trying
  SIP ──▶ 180 Ringing
  SIP ──▶ 200 OK  (SDP answer: PCMU, RTP port 40000)
  SIP ◀── ACK  → call established, media flowing

  RTP ═══▶ [agent] Thanks for calling Aurora Hotel reservations. How can I help?
  RTP ◀═══ [caller] I need to change a reservation, but I do not have the confirmation number.
        │ VAD: endpoint detected → STT → agent
  RTP ═══▶ [agent] I can help with hotel reservations, or connect you to the front desk. What would you prefer?
  RTP ◀═══ [caller] This is confusing, can I just talk to a person?
        │ VAD: endpoint detected → STT → agent
  RTP ═══▶ [agent] Transferring you to the front desk.
        │ tool action: transfer

  SIP ──▶ REFER  Refer-To: sip:front-desk@voice.demo  → warm transfer
  SIP ◀── 202 Accepted  → caller re-INVITEd to human queue

  [call ended] transcript saved · duration logged · 2 caller turns
```

### 1d. The interactive IVR menu

```bash
python3 ivr_menu_mock.py
```

Type a digit (`1`/`2`/`3`/`0`) or a phrase (`book`, `hours`, `human`), or `q` to quit.
Example session (input: `1`, `hours`, `0`):

```
Thanks for calling Aurora Hotel. Tell me what you need, or press a key:
  1 or 'book'     → new reservation
  2 or 'change'   → change or cancel reservation
  3 or 'hours'    → front desk hours
  0 or 'human'    → talk to the front desk

caller>   → branch: booking
  agent says: Sure  -  what dates and how many guests?
  TOOL FIRES: check_availability(check_in, check_out, guests)

caller>   → branch: hours
  agent says: We're open 9am to 6pm, Monday through Friday. Anything else?
  (answered inline  -  no tool call)

caller>   → branch: human
  agent says: No problem  -  connecting you to a representative now.
  TOOL FIRES: transfer_to_human()  → SIP REFER to front-desk
```

> Note: routing is first-match-by-keyword, so an ambiguous phrase like "change my room"
> resolves to **booking** if "room" appears first in the branch checks. Fine for the demo.

**If all of Part 1 printed the output above, the system is verified.** Everything past here
just swaps the mock for real speech.

---

## Part 2  -  Install for live speech

```bash
cd ../pipeline
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

If `sounddevice` fails to import later, install PortAudio: `brew install portaudio`.

Create your `.env`:

```bash
cp config.example.env .env
```

Edit `.env` for OpenAI:

```
PROVIDER=openai
OPENAI_API_KEY=<your key>
TTS_BACKEND=system
```

Use `TTS_BACKEND=system` while rehearsing to keep the demo cheaper and avoid provider
TTS latency. Switch to provider TTS only when you want a polished voice.

---

## Part 3  -  Run live

Typed input against the live LLM + tools (no mic needed  -  good first live check):

```bash
python3 voice_loop.py --text
```

Full voice (mic → speech → agent → spoken reply):

```bash
python3 voice_loop.py
```

Speak, pause, and the agent replies. The per-turn latency table now shows **real** stt /
llm+tools / tts milliseconds  -  point out that the LLM stage dominates the ~800 ms budget.

Switch to Groq any time by editing `.env`:

```
PROVIDER=groq
GROQ_API_KEY=<your key>
```

Nothing else changes  -  same commands, same loop.

---

## Part 4  -  Optional LiveKit room/session demo

This step is optional. It shows the real room/session abstraction that sits between a local
voice agent and a production telephony setup. It runs locally and does not require LiveKit
Cloud. It does not configure SIP by itself.

```bash
cd ../livekit
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
```

Start Docker Desktop, then start a local LiveKit server in a separate terminal:

```bash
./start_local_server.sh
```

The local development defaults are:

```text
LIVEKIT_URL=http://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_ROOM=aurora-demo-room
```

Create a room:

```bash
python create_room.py
```

Create caller and agent participant tokens:

```bash
python create_token.py --identity caller-demo --name "Caller Demo"
python create_token.py --identity aurora-agent --name "Aurora Agent"
```

Mimic a caller and agent talking:

```bash
python talk_server.py
```

Open `http://localhost:5173` in two browser tabs. Join one tab as `Caller Demo`
and the other as `Aurora Agent`, then allow microphone access in both tabs.

Conceptually:

```
LiveKit room = call/session
caller-demo = caller participant
aurora-agent = agent participant
audio track = voice media
```

For real SIP, add a LiveKit SIP trunk, dispatch rule, and an agent worker that joins the room.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `RuntimeError: Set GROQ_API_KEY...` | Set `PROVIDER=openai` with `OPENAI_API_KEY`, add a Groq key, or run with `PROVIDER=mock` |
| `RuntimeError: Set OPENAI_API_KEY...` | Add `OPENAI_API_KEY` to `.env`, or run with `PROVIDER=mock` |
| `ModuleNotFoundError: openai` | You're live without installing  -  `pip install -r requirements.txt`, or use `PROVIDER=mock` (needs nothing) |
| `sounddevice`/PortAudio error | `brew install portaudio`, or use `--text` mode |
| Provider TTS error / no audio | Set `TTS_BACKEND=system` |
| Mic doesn't capture | Grant terminal microphone permission, or use `--text` |
| Everything feels slow | Try `LLM_MODEL=llama-3.1-8b-instant` in `.env` (faster, weaker tool use) |
| Live services down mid-demo | `PROVIDER=mock`  -  the whole thing runs offline instantly |

---

## What's been verified vs. what needs your machine

- **Verified offline** (Part 1): `smoke_test.py`, `voice_loop.py --text` (mock), `demo_call.py`
  (both scenarios), `ivr_menu_mock.py`. Outputs above are the actual captured runs.
- **Needs your laptop** (Parts 2-3): the `pip install`, a real OpenAI/Groq key, and mic-mode
  `voice_loop.py`. Do one live run before the session using the setup steps in `README.md`.
- **Optional LiveKit** (Part 4): Docker or a local LiveKit server binary if you want to create
  a local room and participant tokens.
