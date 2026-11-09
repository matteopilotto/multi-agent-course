# Notes

## Preferences
- Socratic. Ask, let them reason, reveal only when stuck (course CLAUDE.md + progress file).
- "Help me implement" = coach step by step; never write the solution into their file.
- Assignment AGENTS.md checkpoint rule: one stage at a time, ask the *You decide* question, never pick for them; they run *Prove it* themselves, never write BUILD_LOG.md / DESIGN.md.
- Known weak spot from M01–M03: name typos that only fail at runtime, and catch-all `try` blocks hiding them. That matters a lot here, because the assignment's "fail loud" rule (SPEC R-4) is the same lesson.
- Other recurring weak spots: "who acts vs who decides" (passive "it"), JSON nesting levels. Both come up again with MCP/A2A payloads.

- 2026-11-07: learner says they didn't cover Module 3 themselves (despite progress-file entries). Don't use Module 3 work as known ground or as hints.

## Weekend plan (lesson → assignment stage)
| Lesson | Concept | Stages |
|---|---|---|
| 0001 | MCP: what crosses the wire | 1 (DB), 2 (tools, access control) |
| 0002 | ADK: LlmAgent, Runner, sessions, events | 3 (agent + bare CLI), 4 (pipeline + events) |
| 0003 | Tracing: spans, trees, OpenTelemetry → Phoenix | 5 |
| 0004 | A2A: agent cards, tasks, JSON-RPC services | 6 (Judge), 8 (Masker) |
| 0005 | Guards measured on both sides | 6, 7, 10 |
| 0006 | Memory as a step, not a tool | 8 |
| 0007 | Streaming NDJSON to a UI | 9 |
Fill Module 2 gaps (orchestrator vs pipeline, isolated context) inside 0002/0004 as they come up.

## Working notes
- Source drift to watch: MCP latest spec (2026-07-28) is stateless, with no initialize handshake. Toolbox tools.yaml moved to the flat per-document `kind:` format.
- 2026-11-07: build repo is `~/Documents/repos/support-desk` (git init, no commits yet; provided Markdown copied unchanged; .gitignore keeps runs/failing/ and reports/eval.json). Reading check failed → Thanos note + README banner added there per AGENTS.md (uncommitted; learner removes them).
- Machine: Homebrew PG14 is broken (icu4c). Working Postgres 18 in conda env `customer-support`, data dir ~/postgres_data. Docker installed, daemon off. Port 5000 = macOS AirPlay → raise at Stage 2 (Toolbox default port).
- Stage 1 decision (2026-11-07): learner chose A (conda PG 18 + drop/recreate/insert reset), reason: no Docker dependency. Reasoned unaided that DROP loses GRANTs, so grants must be re-applied after recreate. Told: the role is cluster-wide and survives drops, so create it once outside the reset. HOLD for Stage 2 (let them hit it): inserting into actions_log also needs USAGE on actions_log_id_seq ("permission denied for sequence").
- 2026-11-07: Stage 1 DONE and pushed (support-desk 57d6c15): db/setup.sql, db/seed.sql, run.sh reset, BUILD_LOG Stage 1 complete. Learner asked Claude to write seed.sql, run.sh and to format/reword BUILD_LOG text; they were overwhelmed, so smaller steps helped. Next: Stage 2 decision (ownership enforcement), lesson 0001 §7.
- 2026-11-07: Stage 2 DONE and pushed (support-desk 3ea224c). Toolbox on 5050 with --enable-api and allowed-hosts/origins locked to local. action-log uses INSERT…SELECT…WHERE + RETURNING id (needs GRANT SELECT (id)). Learner saw {"result":"[]"} and the double-decode truthiness trap ('[]' is truthy). Next: lesson 0002 (ADK) → Stage 3; open questions there: how login reads users (no grant yet), and verify bound param is absent from the model-visible schema.
- 2026-11-07: lesson 0002 (ADK) written + reference/adk-cheatsheet.html. Verified live (Toolbox on 5050, read-only tools/list): with bound_params={"customer_email": …}, get-order-status shows only order_id and find-customer-orders shows no params; the email is removed from the description's Args too. BUT action-log's email param is named `user_email`, so it stays model-visible and required (M-5 gap). `load_toolset(..., strict=True)` raises "unused bound parameters: customer_email" for action-log. HOLD: the lesson's peek.py task is built for them to find this; don't reveal. Cheat sheet deliberately omits "binding is by name" until they find it, then add it.
- 2026-11-07: support-desk working tree shows BUILD_LOG.md deleted (` D`), not by Claude. Ask the learner before Stage 3; don't restore it unprompted. Also `.env` has no GOOGLE_API_KEY yet.
