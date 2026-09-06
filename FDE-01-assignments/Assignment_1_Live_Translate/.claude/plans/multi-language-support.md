# Plan — Multi-language support for Live Translate

> On approval, also save a copy of this plan to
> `FDE/Assignment_1_Live_Translate/.claude/plans/` (the user's requested location).

## Context

Today the widget only translates English → **Mexican Spanish (es-MX)**. We want users to
choose among five targets: **Mexican Spanish (`es-MX`, default), Spanish/Castilian (`es-ES`),
Italian (`it`), French (`fr`), German (`de`)**.

The good news from exploration: the `target` parameter is **already threaded end-to-end** —
the widget sends it on `POST /translate/batch`, the Node gateway forwards it
([server.js:74-94](FDE/Assignment_1_Live_Translate/backend/gateway-node/server.js#L74-L94)),
the FastAPI models accept it
([app.py:40-46](FDE/Assignment_1_Live_Translate/backend/ai-service-python/app.py#L40-L46)),
and it is **already part of the cache key**
([cache.py:22](FDE/Assignment_1_Live_Translate/backend/ai-service-python/lib/cache.py#L22)),
so each language gets its own cache entries for free.

Only **two** places actually ignore `target`:
1. The LLM prompt hardcodes Mexican Spanish and never reads `target`.
2. The widget has no language selector — `TARGET` is hardcoded to `es-MX`.

This plan closes exactly those two gaps. **No changes to `gateway-node`, `app.py`, or
`cache.py` are needed.**

## Scope decisions (confirmed with user)

- Selector added in **both** the widget UI **and** the extension popup.
- Plain "Spanish" maps to **Castilian `es-ES`** (Spain), distinct from `es-MX`.

---

## 1. Backend — make the prompt target-aware

**File:** [backend/ai-service-python/lib/llm.py](FDE/Assignment_1_Live_Translate/backend/ai-service-python/lib/llm.py#L53-L71)

Replace the static `SYSTEM_PROMPT` constant (lines 53-58) with a small language map + a
builder, and use it inside `translate_text` (lines 61-71).

- Add a module-level dict mapping each supported code to a natural-language description:
  ```python
  LANG_INSTRUCTIONS = {
      "es-MX": "natural MEXICAN Spanish (es-MX) — not generic or Castilian Spanish",
      "es-ES": "natural Castilian Spanish (es-ES) as spoken in Spain — not Latin-American Spanish",
      "it":    "natural Italian (it)",
      "fr":    "natural French (fr)",
      "de":    "natural German (de)",
  }
  ```
- Add `_system_prompt(target)` that interpolates the description and keeps the existing
  guardrails verbatim ("Return ONLY the translation…", "Keep numbers, prices (with $), and
  product/model codes unchanged."). Unknown/missing codes fall back to `es-MX` (preserves
  today's behavior — safer than emitting an unsupported language).
- In `translate_text`, pass `_system_prompt(target)` as the system message instead of the
  constant. `target` is now genuinely used.

No signature changes; `translate_one` in `app.py` already forwards `target` here.

---

## 2. Widget UI — language dropdown

**File:** [widget/translation-widget.js](FDE/Assignment_1_Live_Translate/widget/translation-widget.js)
(the canonical copy served at `/widget.js` and via `<script>`).

Note: this file is labeled "PROVIDED — do not rewrite"; the user has approved editing it to
add the selector. Keep edits minimal and in the existing style.

- Add a `LANGUAGES` list near `CONFIG` (label + code for the five targets).
- Introduce state `let currentTarget = CONFIG.TARGET;` (line ~40), initialized from
  `CONFIG.TARGET` so an externally-set default (extension) is honored.
- Insert a `<select id="fde-lang">` into the panel body
  ([lines 151-157](FDE/Assignment_1_Live_Translate/widget/translation-widget.js#L151-L157)),
  above "Translate page", with the five `<option>`s and `currentTarget` preselected.
- Add a small `.fde-select` rule to the `css` string (lines 52-128), matching the existing
  emerald/off-black token set and the dark-mode block.
- Wire `change` on the select to set `currentTarget` (near the other listeners, lines 167-170).
- In `translatePage`, send `target: currentTarget` instead of `CONFIG.TARGET`
  ([line 204](FDE/Assignment_1_Live_Translate/widget/translation-widget.js#L204)).
- Update the static copy strings from "Mexican Spanish" to language-neutral wording
  (subtitle line 147, lead line 152).

---

## 3. Extension — popup selector + config passthrough

The extension ships its **own copy** of the widget and a popup. Apply the same widget change,
then add a popup selector that sets a default target.

- **[extension/translation-widget.js](FDE/Assignment_1_Live_Translate/extension/translation-widget.js)**
  — apply the identical dropdown change as §2. Additionally, in its existing
  `FDE_CONFIG_CHANGED` handling, update `currentTarget` and the `<select>`'s value from
  `CONFIG.TARGET`/`window.FDE_CONFIG.TARGET` so a popup change reflects live.
- **[extension/popup.html](FDE/Assignment_1_Live_Translate/extension/popup.html#L22-L34)**
  — add a `<label>` + `<select id="target">` with the five languages, above the Translate button.
- **[extension/popup.js](FDE/Assignment_1_Live_Translate/extension/popup.js)** — on load, read
  `target` from `chrome.storage.sync` (default `"es-MX"`) and set the select; on change (or on
  Save), persist `chrome.storage.sync.set({ target })`.
- **[extension/content.js](FDE/Assignment_1_Live_Translate/extension/content.js#L12-L25)** —
  extend the `storage.sync.get` to also read `target` and set `window.FDE_CONFIG.TARGET`; in the
  `onChanged` listener, handle `changes.target` and dispatch the existing `FDE_CONFIG_CHANGED`
  event (widget already listens).

---

## 4. Cosmetic copy (optional, low priority)

- [extension/manifest.json](FDE/Assignment_1_Live_Translate/extension/manifest.json#L3-L5)
  name/description ("EN → Mexican Spanish" → e.g. "EN → 5 languages").
- [demo-pages/index.html](FDE/Assignment_1_Live_Translate/demo-pages/index.html#L27) body copy.

---

## Files touched

| File | Change |
|------|--------|
| `backend/ai-service-python/lib/llm.py` | target-aware prompt (the core fix) |
| `widget/translation-widget.js` | dropdown, state, CSS, target wiring |
| `extension/translation-widget.js` | same dropdown + FDE_CONFIG_CHANGED target sync |
| `extension/popup.html` / `popup.js` | language `<select>`, load/save to storage |
| `extension/content.js` | read + relay `target` from storage |
| `manifest.json`, `demo-pages/index.html` | optional copy tweaks |

**Not touched:** `gateway-node/server.js`, `app.py`, `cache.py` — already target-aware.

---

## Verification

**Backend (isolates the real logic):** start the AI service and confirm each target yields a
different language and that guardrails hold:
```bash
cd FDE/Assignment_1_Live_Translate/backend/ai-service-python
uvicorn app:app --port 8000     # with a valid OPENROUTER_API_KEY in .env
for t in es-MX es-ES it fr de; do
  curl -s localhost:8000/translate -H 'Content-Type: application/json' \
    -d "{\"text\":\"Hello, the price is \$5\",\"target\":\"$t\"}"; echo
done
```
Expect five distinct translations; `$5` preserved in all.

**Cache separation:** repeat one call → `"cached": true`; a different target on the same text →
cache miss (`cached:false`) then hit. `GET /stats` reflects the entries.

**Full stack + widget:** run the Node gateway + AI service, open
`demo-pages/index.html` (or any page via the console loader). In the widget: pick each language
from the dropdown, click **Translate page**, confirm the page renders in that language, then
**Restore page** returns English.

**Extension:** load `extension/` unpacked, open the popup, change **Language**, translate a
page; verify the in-widget dropdown reflects the popup choice (via `FDE_CONFIG_CHANGED`).

**Optional regression:** re-run the product eval (`fde-live-translate-eval` skill) to confirm
the es-MX baseline still scores as before.
