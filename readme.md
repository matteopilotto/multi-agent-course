# Agent Engineering Bootcamp: Developers Edition

Welcome to the official course repository for **Agent Engineering Bootcamp: Developers Edition**.

This repo contains all the code, notebooks, exercises, and project materials used throughout the course — a structured journey from deployment efficiency to validated, production-grade agentic systems. You'll master the full stack: the agent harness and ReAct orchestration, LLM optimization, hybrid memory (RAG + Knowledge Graphs), multi-agent coordination, and the evaluation discipline that proves it all works.

🔗 [Visit course page](https://maven.com/boring-bot/advanced-llm)

---

<img width="2752" height="auto" alt="Agent Engineering Bootcamp" src="assets/image.png" />

## Quick Links

**Course modules** (in teaching order):

1. [Module 1 — The Agent Loop, ReAct & the Harness](#module-1--the-agent-loop-react--the-harness)
2. [Module 2 — LLM Quantization, KV Caching & Speculative Decoding](#module-2--llm-quantization-kv-caching--speculative-decoding)
3. [Module 3 — Agentic RAG, Semantic Cache & Knowledge Graphs](#module-3--agentic-rag-semantic-cache--knowledge-graphs)
4. [Module 4 — Voice Agents](#module-4--voice-agents)
5. [Module 5 — Multi-Agent Systems (MCP · A2A · ADK)](#module-5--multi-agent-systems-mcp--a2a--adk)
6. [Module 6 — Evaluation & Guardrails](#module-6--evaluation--guardrails)

**Also on this page:** [How to use this repo](#how-to-use-this-repo) · [Technology stack](#technology-stack) · [What you'll build](#what-youll-build)

---

## How to Use This Repo

- Content is organized **module by module** under `modules/`, aligned with the live sessions and project milestones.
- **Google Colab Pro** is the preferred environment for the notebooks. You can also **clone locally** and run them in Jupyter or your IDE.
- Most notebooks include their own dependencies via `!pip install`; where a module needs more, a `requirements.txt` sits alongside it.

### Learn with Claude (AI tutor)

This repo is also set up to be **read and used with [Claude](https://claude.com/claude-code)** as a personal tutor. Drop the folder into Claude Code (or upload it to Claude.ai) and Claude reads `CLAUDE.md` to act as a patient, interactive guide through the course — teaching one concept at a time, checking your understanding, and tracking your progress in `progress/learner-progress.md`.

**Get started:** open the folder in Claude Code and type `/start`, or paste *"Read CLAUDE.md and run the `/start` onboarding"* into Claude.ai. Claude will greet you, ask how you like to learn, and begin Module 1.

**Slash commands**

- `/start` — onboard: pick a learning style and begin Module 1 (or the next one)
- `/progress` — see where you are, what's next, and any flagged weak spots

**Skills Claude auto-invokes** (in `.claude/skills/`) — just ask in plain language:

| Skill | What it does | Try saying |
|-------|--------------|------------|
| `teach-module` | Runs an interactive lesson for a module, one concept at a time | *"Teach me module 3"* |
| `quiz-me` | Quizzes you and tracks weak spots (never reveals answers first) | *"Quiz me on RAG"* |
| `explain-eli5` | Re-explains a concept as simply as possible, with analogies | *"Explain KV caching like I'm five"* |
| `build-along` | Guides you through a hands-on exercise step by step | *"Let's do the build-along for module 1"* |
| `warmup` | A ~15-min pre-class refresher: recaps the last module, previews the next | *"I have class soon — warm me up for module 2"* |

### Clone locally (optional)

```bash
git clone https://github.com/hamzafarooq/multi-agent-course.git
cd multi-agent-course
python3 -m venv .venv
source .venv/bin/activate
```

### Recommended resource

To go deeper on building LLM applications, see the book
[**Build LLM Applications from Scratch**](https://www.manning.com/books/build-llm-applications-from-scratch).

---

## Course Curriculum

> **The Agentic Systems Roadmap: From Efficiency to Action** — six modules across ~6 weeks, one 2-hour live session each. Every week ends with a working artifact you built yourself.

### Module 1 — The Agent Loop, ReAct & the Harness

Demystify what an agent actually is: the perceive → reason → act loop, the **ReAct** pattern, and what a production **harness** adds on top of a 50-line loop. Build a ReAct agent from scratch, no framework.

**Key topics:** the agent loop · ReAct (Reasoning + Acting) · agent vs. workflow vs. chatbot · debugging via the trace · agent frameworks (smolagents)

---

### Module 2 — LLM Quantization, KV Caching & Speculative Decoding

Make the agent loop fast and cheap enough to ship. Understand where latency really comes from and how to cut it.

**Key topics:** quantization methods (4-bit / 8-bit, FP4 vs. NF4) · KV caching · speculative decoding · inference metrics (TTFT, ITL, throughput) · local vs. cloud hosting


---

### Module 3 — Agentic RAG, Semantic Cache & Knowledge Graphs

Treat retrieval as a tool the agent *decides* to use — not a static bolt-on. Add a semantic cache for real latency/cost wins, and contrast vector RAG with Knowledge Graphs for structured reasoning.

**Key topics:** naive RAG vs. agentic RAG · query routing & multi-hop retrieval · semantic caching · Knowledge Graphs & GraphRAG · text-to-Cypher · RAG vs. KG evaluation


**📊 Featured project: RAG vs. Knowledge Graph comparison framework** — a Streamlit app that objectively compares RAG and KG approaches with LLM-based evaluation and interactive graph visualizations.
[View documentation →](modules/Module_3_Agentic_RAG/Knowledge_Graphs/README.md)

```bash
cd modules/Module_3_Agentic_RAG/Knowledge_Graphs
python setup.py      # one-time setup
streamlit run app.py
```

---

### Module 4 — Voice Agents

Ship an agent that talks — and survives real conversation.

**Key topics:** the voice stack (STT → LLM → TTS) · turn-taking & end-of-turn detection · latency budgeting, streaming & barge-in · tool calling inside a voice loop · provider landscape (Deepgram, ElevenLabs, OpenAI Realtime, Vapi, Retell)


---

### Module 5 — Multi-Agent Systems (MCP · A2A · ADK)

When many agents beat one — and the more common case where they don't. Build a coordinated multi-agent system and learn the protocol layer underneath the marketing.

**Key topics:** one agent vs. many · topologies (orchestrator-worker, hierarchical, swarm, handoff) · **MCP** (tools), **A2A** (agent-to-agent), **ADK** (Google's framework) · shared memory & message passing



---

### Module 6 — Evaluation & Guardrails

Close the loop: ship with measurable quality and safety, not hope.

**Key topics:** input/output guardrails · prompt-injection & jailbreak defense (Llama Guard) · trajectory eval vs. outcome eval · LLM-as-judge (and how to validate the judge) · golden task sets


---

## What You'll Build

This course goes beyond theory. Across the six modules you'll ship:

- An **optimized LLM deployment** with quantization, KV caching, and speculative decoding
- An **agentic RAG pipeline** with a semantic cache layer
- A **Knowledge Graph application** with a RAG-vs-KG evaluation framework
- A **ReAct agent** built from scratch
- A **voice agent** that handles real conversation
- A **multi-agent system** with ADK/A2A/MCP coordination
- An **evaluation + guardrail harness** that validates the whole stack

Each module includes hands-on projects you can showcase in your portfolio.

---

## About the Course

**Agent Engineering Bootcamp: Developers Edition** · ⭐ 4.8/5 (107 reviews)

**Instructor:** [Hamza Farooq](https://www.linkedin.com/in/hamzafarooq/) — Founder · Ex-Google · Professor at UCLA & UMN

A hands-on, build-every-week bootcamp for engineers who already write Python and have touched LLM APIs. Six live 2-hour sessions; you leave with the **judgment** that separates engineers who ship agents from engineers who follow tutorials.


---

*Created by [boring-bot](https://maven.com/boring-bot). Building the future of AI, one agent at a time.*
