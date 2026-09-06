# Fix: extension config race — widget locks in default backend URL

## Context

In the Live Translate Chrome extension, two content scripts are injected in order:
`content.js` then `translation-widget.js` (manifest `content_scripts`, `document_idle`).

- `content.js` reads the saved backend URL asynchronously via
  `chrome.storage.sync.get({ apiUrl: ... }, cb)` and only inside that callback assigns
  `window.FDE_CONFIG = { API_URL: cfg.apiUrl }` ([content.js:13-15](FDE/Assignment_1_Live_Translate/extension/content.js#L13-L15)).
- `translation-widget.js` runs immediately after and captures the config **synchronously**
  into a `const CONFIG` at load time ([translation-widget.js:29-36](FDE/Assignment_1_Live_Translate/extension/translation-widget.js#L29-L36)).

Because the storage callback almost never fires before the widget's synchronous capture,
`CONFIG.API_URL` deterministically snapshots the default `http://localhost:8787`, and — being
a `const` read once — it never re-checks. Result: the URL saved in the popup is ignored on
every page load, and neither reloading the page nor the extension helps.

The storage key is `apiUrl` (written by [popup.js:23](FDE/Assignment_1_Live_Translate/extension/popup.js#L23)),
remapped onto `window.FDE_CONFIG.API_URL` by `content.js`. No `chrome.storage.onChanged`
listener exists anywhere today.

**Intended outcome:** the widget always uses the user's saved backend URL, and a URL saved in
the popup takes effect on an already-open page without requiring a reload.

## Approach

Keep the existing architecture: the widget stays chrome-API-agnostic (it works as a standalone
`widget/` / `loader/` copy too) and consumes `window.FDE_CONFIG` as the bridge. The fix is to
stop snapshotting the URL and instead **resolve it lazily at request time**, plus have
`content.js` keep `window.FDE_CONFIG` current when storage changes.

### 1. `extension/translation-widget.js` — resolve API_URL lazily

- Keep `CONFIG` for the static defaults (`TARGET`, `BATCH_SIZE`) and as the fallback source for
  the default URL, but stop treating `CONFIG.API_URL` as the live value.
- Add a small helper near the `CONFIG` block (~line 36):
  ```js
  function apiUrl() {
    return (window.FDE_CONFIG && window.FDE_CONFIG.API_URL) || CONFIG.API_URL;
  }
  ```
- Replace every point-of-use of `CONFIG.API_URL` with `apiUrl()`:
  - The fetch in `postJSON` — [translation-widget.js:237](FDE/Assignment_1_Live_Translate/extension/translation-widget.js#L237)
    (`fetch(apiUrl() + path, ...)`). This is the only network call and the one that matters for
    correctness; by the time the user triggers a translation the storage callback has long since run.
  - The error message — [translation-widget.js:284](FDE/Assignment_1_Live_Translate/extension/translation-widget.js#L284).
  - The console log — [translation-widget.js:301](FDE/Assignment_1_Live_Translate/extension/translation-widget.js#L301).
- The panel status line built at [translation-widget.js:156](FDE/Assignment_1_Live_Translate/extension/translation-widget.js#L156)
  (`Backend: ${CONFIG.API_URL}`) renders once at panel-build time and can be stale. Update its
  text from the current `apiUrl()` whenever the panel is opened (in the existing open handler),
  and refresh it on config-change (see event below), so the displayed backend reflects reality.

### 2. `extension/content.js` — keep window.FDE_CONFIG live (no-reload update)

- Add a `chrome.storage.onChanged` listener alongside the existing `get`:
  ```js
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.apiUrl) {
      window.FDE_CONFIG = Object.assign({}, window.FDE_CONFIG, { API_URL: changes.apiUrl.newValue });
      window.dispatchEvent(new Event("FDE_CONFIG_CHANGED"));
    }
  });
  ```
  Place it inside the existing IIFE, near the `chrome.runtime.onMessage` block
  ([content.js:20-25](FDE/Assignment_1_Live_Translate/extension/content.js#L20-L25)). Because the
  widget resolves `apiUrl()` lazily, updating `window.FDE_CONFIG` is enough for the next fetch to
  use the new URL — the reload requirement is gone.

### 3. `extension/translation-widget.js` — react to config changes (status only)

- Add a listener for the new event so the visible "Backend:" status stays in sync:
  ```js
  window.addEventListener("FDE_CONFIG_CHANGED", () => {
    const el = document.getElementById("fde-status");
    if (el) el.textContent = "Backend: " + apiUrl();
  });
  ```
  (Fetches already read `apiUrl()` live, so no other state needs updating.)

### Optional cleanup (not required)

The default `http://localhost:8787` is hardcoded in three places (`content.js:13`,
`translation-widget.js:31`, `popup.js:3`). Leave as-is unless the user wants consolidation —
it's out of scope for this bug.

## Files to modify

- `FDE/Assignment_1_Live_Translate/extension/translation-widget.js` (lazy `apiUrl()` helper;
  swap uses at lines 156/237/284/301; add `FDE_CONFIG_CHANGED` listener)
- `FDE/Assignment_1_Live_Translate/extension/content.js` (add `chrome.storage.onChanged` listener)

The standalone `widget/translation-widget.js` and `loader/console-snippet.js` copies are not
injected by the extension and are out of scope; note they share the snapshot pattern if the
user later wants them aligned.

## Verification

1. **Load the unpacked extension** (chrome://extensions → Developer mode → Load unpacked →
   `FDE/Assignment_1_Live_Translate/extension`).
2. **Save a non-default URL** in the popup (e.g. the deployed Fly.io gateway URL or
   `http://localhost:9999`) and click Save.
3. **Race fix:** open/reload any page, open the widget, trigger a translation. Confirm via
   DevTools Network tab (and the `[FDE] Backend:` console log) that the request goes to the saved
   URL, **not** `http://localhost:8787`. Repeat a few reloads — it should be deterministic.
4. **Live update (no reload):** with a page already open, change the URL in the popup and Save.
   Without reloading, confirm the panel's "Backend:" status updates and the next translation
   request hits the new URL.
5. **Fallback:** clear the saved value / disable storage; confirm the widget still falls back to
   `http://localhost:8787` without errors (the `try/catch` and `apiUrl()` fallback cover this).
6. Optionally smoke-test end-to-end against a running gateway on a real page (e.g. the eval flow
   in the `fde-live-translate-eval` skill) to confirm translations still render.
