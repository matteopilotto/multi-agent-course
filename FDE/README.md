# Forward Deployed Engineer (FDE) Track

A hands-on track about making AI capabilities **work in the real world** — in
environments you don't control, with the messy plumbing that separates a demo
from something a customer can actually use.

A Forward Deployed Engineer is the person who takes a capability and stands it
up end to end where it's needed: shipping into a live environment, owning the
service behind it, respecting the interfaces around it, and deploying it so it
keeps running. This track builds that muscle one assignment at a time.

## What makes this track different

Most exercises hand you a clean sandbox. FDE work rarely is one. Here you'll
repeatedly:

- **Ship into environments you didn't build** (a browser, a customer's page, a third-party API).
- **Own a real service** — with an LLM, a cache, logs, health checks, and a deploy.
- **Conform to a contract** you don't get to change.
- **Separate concerns** — app/gateway layers vs. AI layers — and make them talk.
- **Prove it works** with observability, not vibes.

## Assignments

| # | Name | You build | Core skills |
|---|------|-----------|-------------|
| 1 | [Live Translate](Assignment_1_Live_Translate/) | A two-service backend (Node gateway + Python AI service) behind a provided browser widget that live-translates any page EN → Mexican Spanish | LLM calls, caching, structured logging + tracing, service separation, API contracts, deploy on Fly.io |
| … | _more coming_ | | |

Each assignment folder is self-contained with its own `README.md`, provided
scaffolding, and a grading rubric.

## How every FDE project is graded

Consistent across the track: a **measurable rubric** plus a **video demo**.

- Each assignment ships an `eval/` folder with a `rubric.json` and an `eval.py`,
  and a bundled eval **skill** in `.claude/skills/`.
- `python eval/eval.py --student "…" --video "…"` scores the automated criteria
  against the running project and captures evidence, writing an intermediate
  scorecard (`eval/REPORT.md`). The eval skill runs that plus a live real-world
  test and folds it into a **`PRODUCT_EVAL.md`** — the polished Product Evaluation.
- Submission = **`PRODUCT_EVAL.md` (or PDF) + a 60–90s screen recording** — not the
  raw `REPORT.md` scorecard. An `AGENTS.md` in each assignment states the
  non-negotiables so a coding agent (Claude Code) inherits them automatically.

## How to work through an assignment

1. Read the assignment's `README.md` top to bottom before writing code.
2. Run the provided pieces first so you can see what "done" looks like.
3. Build the parts marked as yours; the provided frontend/tests are your acceptance check.
4. Prove it with logs, traces, and stats; deploy it for real; then tackle the stretch goals.

## Prerequisites

- Comfort with a terminal, `git`, and HTTP/JSON.
- **Node 18+** and **Python 3.10+** installed.
- An API key for one LLM provider (Anthropic, Google, or OpenAI).
- A free **[Fly.io](https://fly.io)** account for the deploy step.
