# Optional LiveKit Room Demo

This folder adds a lightweight LiveKit step to the assignment. It is optional. The core hotel voice agent runs without LiveKit.

The goal is to show how a real-time media platform represents a call-like session:

```text
room = session
participant = caller or agent
track = audio stream
```

This is not a full SIP setup. SIP requires additional telephony configuration such as a LiveKit SIP trunk and dispatch rule.

## Install

```bash
cd FDE/Assignment_2_voice_agent/livekit
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
```

## Start A Local LiveKit Server

This demo is local-first. You do not need LiveKit Cloud credentials.
Make sure Docker Desktop is running first.

In a separate terminal, run:

```bash
./start_local_server.sh
```

The local dev server uses:

```env
LIVEKIT_URL=http://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_ROOM=aurora-demo-room
```

The scripts use these local defaults automatically.

## Optional: Override Configuration

The local defaults are enough for the workshop. If you already have another LiveKit
server, you can override `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
and `LIVEKIT_ROOM` in a local `livekit/.env` file. The scripts also check
`pipeline/.env`. Do not commit real credentials.

## Create A Room

```bash
python create_room.py
```

## Create Join Tokens

Caller token:

```bash
python create_token.py --identity caller-demo --name "Caller Demo"
```

Agent token:

```bash
python create_token.py --identity aurora-agent --name "Aurora Agent"
```

The caller token represents a user or phone caller. The agent token represents the voice agent joining the same room.

## Mimic A Conversation In Two Browser Tabs

Token creation does not join anyone to the room. A participant joins only when a
client uses a token to connect and publish audio.

Start the local talk client:

```bash
python talk_server.py
```

Open `http://localhost:5173` in two browser tabs:

- In tab 1, choose `Caller Demo` and click `Join`.
- In tab 2, choose `Aurora Agent` and click `Join`.
- Allow microphone access in both tabs.

Now the two tabs are real LiveKit participants in `aurora-demo-room`. Speak in one
tab and listen in the other. This mimics the media/session layer, not the hotel
agent brain.

To make Aurora answer as the actual hotel agent, the next production step is an
agent worker that joins as `aurora-agent`, subscribes to caller audio, runs STT,
calls the hotel agent tools, and publishes TTS audio back into the room.

## How This Maps To SIP

| SIP Demo | LiveKit Room Demo |
|----------|-------------------|
| SIP INVITE creates a call | Room is created or joined |
| Caller sends RTP audio | Caller participant publishes an audio track |
| Agent replies with RTP audio | Agent participant publishes an audio track |
| REFER transfers the call | App or SIP layer routes participant to another destination |
| BYE ends the call | Participant leaves or room closes |

## Production Extension

To turn this into a real SIP demo, add:

- LiveKit SIP trunk
- Dispatch rule that sends inbound calls to a room
- Agent worker that joins the room
- Audio bridge between LiveKit tracks and the hotel agent pipeline
- Transfer handling for front-desk escalation
