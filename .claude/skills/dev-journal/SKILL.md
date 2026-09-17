---
name: dev-journal
description: Write the developer journal entry for this session into docs/journal/ and index it in DEV_JOURNAL.md.
disable-model-invocation: true
---

# Dev journal

One entry per session, written for a reader weeks from now with no memory of the
conversation: what was worked on, why each decision went the way it did, what was learned.
The latest file in `docs/journal/` is the exemplar for voice and depth; read it before
writing. Optional argument: a title hint.

## Steps

1. **Gather the evidence.** Read `DEV_JOURNAL.md` to find the last entry, then
   `git log` from that entry's last commit to `HEAD` and the working-tree status. Done when
   every commit since the last entry and every uncommitted change is on your list.
2. **Walk the conversation** against that list, recording per item: what was done (file
   paths, function names, commands), the decision behind it with the alternatives that were
   actually discussed, and whether it was **verified** (ran, tested, output seen) or only
   **proposed**. Done when each decision carries either its stated rationale or the exact
   words *rationale not discussed*.
3. **Write the entry** to `docs/journal/YYYY-MM-DD-short-title.md`, today's date, heading
   `# YYYY-MM-DD — <one-line title>`, sections in this order: Goal · Context · What was done ·
   Decisions · Dead ends · Learnings · Open questions and next steps. If today's file already
   exists, append a new dated section under it. Done when the file reads standalone.
4. **Index it.** Add a line to `DEV_JOURNAL.md` in the existing link format, newest last.

## Writing rules

- First person, past tense, concise. Under 500 words unless the session was unusually
  complex; the exemplar shows what complex earns.
- Reference commits and files; quote a snippet only when it carries the key insight.
- Tag every claim of behaviour as verified or proposed. A number from one run is one run,
  say so.
- Record only what happened in the conversation. A decision whose reasoning was never spoken
  gets *rationale not discussed*, not a plausible reason.
- Dead ends belong in the entry with why they failed; they are the part a teammate cannot
  recover from the git log.
- Close with **ADR candidates:** any decision significant enough for an Architecture
  Decision Record, one line each.
