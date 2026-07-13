/* FDE · Assignment 1 · Extension popup  (PROVIDED) */
const $ = (id) => document.getElementById(id);
const DEFAULT_URL = "http://localhost:8787";

function setStatus(text, kind) {
  const s = $("status");
  s.textContent = text;
  s.className = "status" + (kind ? " " + kind : "");
}

async function sendToTab(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type });
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get({ apiUrl: DEFAULT_URL, target: "es-MX" }, (cfg) => {
    $("apiUrl").value = cfg.apiUrl;
    $("target").value = cfg.target;
  });

  $("save").addEventListener("click", () => {
    const apiUrl = $("apiUrl").value.trim() || DEFAULT_URL;
    const target = $("target").value;
    chrome.storage.sync.set({ apiUrl, target }, () => setStatus("Saved. Reload the page to apply.", "ok"));
  });

  $("target").addEventListener("change", () => {
    chrome.storage.sync.set({ target: $("target").value });
  });

  $("health").addEventListener("click", async () => {
    const apiUrl = $("apiUrl").value.trim() || DEFAULT_URL;
    setStatus("Checking…");
    try {
      const res = await fetch(apiUrl + "/health");
      const data = await res.json();
      setStatus("Backend OK · " + JSON.stringify(data).slice(0, 80), "ok");
    } catch (e) {
      setStatus("Cannot reach " + apiUrl + " — is the gateway running?", "err");
    }
  });

  $("page").addEventListener("click", () => sendToTab("TRANSLATE_PAGE"));
  $("restore").addEventListener("click", () => sendToTab("RESTORE_PAGE"));
});
