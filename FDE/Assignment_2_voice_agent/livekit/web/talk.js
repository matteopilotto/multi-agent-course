import { Room, RoomEvent } from "../node_modules/livekit-client/dist/livekit-client.esm.mjs";

const statusEl = document.querySelector("#status");
const identityEl = document.querySelector("#identity");
const joinEl = document.querySelector("#join");
const leaveEl = document.querySelector("#leave");
const muteEl = document.querySelector("#mute");
const participantsEl = document.querySelector("#participants");
const audioEl = document.querySelector("#audio");

let room = null;
let muted = false;

function setStatus(message) {
  statusEl.textContent = message;
}

function participantName(participant) {
  return participant.name || participant.identity;
}

function renderParticipants() {
  participantsEl.innerHTML = "";
  if (!room) return;

  const participants = [room.localParticipant, ...room.remoteParticipants.values()];
  for (const participant of participants) {
    const row = document.createElement("div");
    row.className = "participant";
    row.innerHTML = `
      <strong>${participantName(participant)}</strong>
      <span>${participant.isLocal ? "local" : "remote"}</span>
    `;
    participantsEl.appendChild(row);
  }
}

async function join() {
  const identity = identityEl.value;
  const name = identity === "aurora-agent" ? "Aurora Agent" : "Caller Demo";
  setStatus("Creating token...");

  const response = await fetch(`/token?identity=${encodeURIComponent(identity)}&name=${encodeURIComponent(name)}`);
  const session = await response.json();

  room = new Room({ adaptiveStream: true, dynacast: true });
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === "audio") {
      const element = track.attach();
      audioEl.appendChild(element);
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach());
  room.on(RoomEvent.ParticipantConnected, renderParticipants);
  room.on(RoomEvent.ParticipantDisconnected, renderParticipants);

  setStatus(`Joining ${session.room} as ${session.identity}...`);
  await room.connect(session.url, session.token);
  await room.localParticipant.setMicrophoneEnabled(true);

  muted = false;
  joinEl.disabled = true;
  leaveEl.disabled = false;
  muteEl.disabled = false;
  muteEl.textContent = "Mute mic";
  identityEl.disabled = true;
  setStatus(`Connected to ${session.room} as ${session.identity}`);
  renderParticipants();
}

async function leave() {
  if (room) {
    room.disconnect();
    room = null;
  }
  audioEl.innerHTML = "";
  participantsEl.innerHTML = "";
  joinEl.disabled = false;
  leaveEl.disabled = true;
  muteEl.disabled = true;
  identityEl.disabled = false;
  setStatus("Disconnected");
}

async function toggleMute() {
  if (!room) return;
  muted = !muted;
  await room.localParticipant.setMicrophoneEnabled(!muted);
  muteEl.textContent = muted ? "Unmute mic" : "Mute mic";
}

joinEl.addEventListener("click", () => join().catch((error) => setStatus(error.message)));
leaveEl.addEventListener("click", () => leave());
muteEl.addEventListener("click", () => toggleMute().catch((error) => setStatus(error.message)));
