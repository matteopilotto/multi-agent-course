<div align="center">

# 🤖 Agent Engineering Bootcamp
### Developers Edition

**From a 50-line agent loop to validated, production-grade agentic systems — built every week, by you.**

[![Course](https://img.shields.io/badge/Maven-Live%20Cohort-6E40C9?style=for-the-badge)](https://maven.com/boring-bot/advanced-llm)
&nbsp;
![Rating](https://img.shields.io/badge/★%204.8%2F5-107%20reviews-FF6F61?style=for-the-badge)
&nbsp;
![Modules](https://img.shields.io/badge/6%20Modules-~6%20weeks-2EA043?style=for-the-badge)
&nbsp;
[![Built with Claude](https://img.shields.io/badge/Built%20with-Claude%20Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://claude.com/claude-code)

[**Course page**](https://maven.com/boring-bot/advanced-llm) · [**Curriculum**](#course-curriculum) · [**What you'll build**](#what-youll-build) · [**Sprint Zero capstone**](#full-stack-projects) · [**Learn with Claude**](#learn-with-claude-ai-tutor)

<img width="900" alt="Agent Engineering Bootcamp" src="assets/image.png" />

</div>

---

Welcome to the official course repository for **Agent Engineering Bootcamp: Developers Edition** — all the code, notebooks, exercises, and project materials used throughout the course. It's a structured journey from deployment efficiency to validated agentic systems: the agent harness and ReAct orchestration, LLM optimization, hybrid memory (RAG + Knowledge Graphs), multi-agent coordination, and the evaluation discipline that proves it all works.

## Quick Links

**Course modules** (in teaching order):

1. [Module 1 — The Agent Loop, ReAct & the Harness](#module-1--the-agent-loop-react--the-harness)
2. [Module 2 — Skills, Subagents & Multi-Agent Orchestration](#module-2--skills-subagents--multi-agent-orchestration)
3. [Module 3 — Agentic RAG, Semantic Cache & Knowledge Graphs](#module-3--agentic-rag-semantic-cache--knowledge-graphs)
4. [Module 4 — Evaluation & Guardrails](#module-4--evaluation--guardrails)
5. [Module 5 — Multi-Agent Systems (MCP · A2A · ADK)](#module-5--multi-agent-systems-mcp--a2a--adk)
6. [Module 6 — Voice Agents & LLM Optimization](#module-6--voice-agents--llm-optimization)

**Also on this page:** [How to use this repo](#how-to-use-this-repo) · [Technology stack](#technology-stack) · [What you'll build](#what-youll-build)

### 🗺️ Course at a glance

| # | Module | The big idea | You ship |
|---|--------|--------------|----------|
| 1️⃣ | **The Agent Loop, ReAct & the Harness** | What an agent *actually* is | A ReAct agent from scratch |
| 2️⃣ | **Skills, Subagents & Orchestration** | One agent → a coordinated system | **Sprint Zero** — a multi-agent app builder |
| 3️⃣ | **Agentic RAG, Semantic Cache & KGs** | Retrieval as a tool the agent chooses | A RAG-vs-KG eval app + a cited video-moment RAG |
| 4️⃣ | **Evaluation & Guardrails** | Ship with proof, not hope | An eval + guardrail harness |
| 5️⃣ | **Multi-Agent Systems (MCP · A2A · ADK)** | When many agents beat one | A coordinated multi-agent system |
| 6️⃣ | **Voice Agents & LLM Optimization** | An agent that talks — fast and cheap | A real-time voice agent |

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
| `explain-eli5` | Re-explains a concept as simply as possible, with analogies | *"Explain isolated context like I'm five"* |
| `build-along` | Guides you through a hands-on exercise step by step | *"Let's do the build-along for module 1"* |
| `warmup` | A ~15-min pre-class refresher: recaps the last module, previews the next | *"I have class soon — warm me up for module 2"* |

### Clone locally (optional)

```bash
git clone https://github.com/hamzafarooq/multi-agent-course.git
cd multi-agent-course
python3 -m venv .venv
source .venv/bin/activate
```

### Clone via Claude Code chat

You can clone this repo directly from the Claude Code chat interface without leaving your conversation:

1. Open [Claude Code](https://claude.ai/code) in your browser (or launch `claude` in your terminal)
2. In the chat, type:
   ```
   Clone https://github.com/hamzafarooq/multi-agent-course.git and open it
   ```
3. Claude will clone the repo into a directory of your choice, set up the project, and open it — ready for you to start learning.

From there, type `/start` to begin the AI-guided onboarding.

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

### Module 2 — Skills, Subagents & Multi-Agent Orchestration

Go from *one* agent doing one thing well to a *coordinated system* of agents. Learn why isolated context windows are the whole point, the orchestrator + subagents pattern, and how to define your own subagents — then watch the pattern run end to end in **Sprint Zero**.

**Key topics:** agents vs. subagents · isolated context windows · the orchestrator pattern (sequential vs. parallel) · defining subagents in `.claude/agents/` · specialization & the shared-spec coordination layer · multi-agent failure modes · the Sprint Zero capstone

**📦 Featured project: [Sprint Zero](#sprint-zero--a-multi-agent-product-team-in-your-terminal)** — the module's capstone: a multi-agent system that turns a product URL and three answers into six spec docs and a working full-stack app.


---

### Module 3 — Agentic RAG, Semantic Cache & Knowledge Graphs

Treat retrieval as a tool the agent *decides* to use — not a static bolt-on. Add a semantic cache for real latency/cost wins, and contrast vector RAG with Knowledge Graphs for structured reasoning.

**Key topics:** naive RAG vs. agentic RAG · query routing & multi-hop retrieval · query decomposition + HyDE · hybrid retrieval & RRF fusion · cross-encoder re-ranking · semantic caching · Knowledge Graphs & GraphRAG · text-to-Cypher · RAG vs. KG evaluation · moment-level video RAG

> 🗺️ **New here?** [Module 3 at a glance](modules/Module_3_Agentic_RAG/README.md#module-3-at-a-glance) — a one-screen map of the four pieces below.

![Module 3 mind map — Agentic RAG, Semantic Cache, Knowledge Graphs, and Moment RAG](modules/Module_3_Agentic_RAG/module-3-mindmap.png)

**📊 Featured project: RAG vs. Knowledge Graph comparison framework** — a Streamlit app that objectively compares RAG and KG approaches with LLM-based evaluation and interactive graph visualizations.
[View documentation →](modules/Module_3_Agentic_RAG/Knowledge_Graphs/README.md)

```bash
cd modules/Module_3_Agentic_RAG/Knowledge_Graphs
python setup.py      # one-time setup
streamlit run app.py
```

**🎬 Featured project: Moment RAG** — agentic RAG on *video*. Ask a complex question and get a streamed, **cited** answer where every citation pops up the source YouTube episode at the **exact moment**, with a synced transcript. Pipeline: self-query → decompose → hybrid retrieve (dense + BM25 + HyDE questions, RRF) → cross-encoder re-rank → cited synthesis.
[View documentation →](modules/Module_3_Agentic_RAG/Moment_RAG/README.md)

```bash
cd modules/Module_3_Agentic_RAG/Moment_RAG
pip install -r requirements.txt
cp .env.example .env      # add OPENAI_API_KEY
uvicorn app:app --reload  # open http://localhost:8000
```

---

### Module 4 — Evaluation & Guardrails

Close the loop: ship with measurable quality and safety, not hope.

**Key topics:** input/output guardrails · prompt-injection & jailbreak defense (Llama Guard) · trajectory eval vs. outcome eval · LLM-as-judge (and how to validate the judge) · golden task sets


---

### Module 5 — Multi-Agent Systems (MCP · A2A · ADK)

When many agents beat one — and the more common case where they don't. Build a coordinated multi-agent system and learn the protocol layer underneath the marketing.

**Key topics:** one agent vs. many · topologies (orchestrator-worker, hierarchical, swarm, handoff) · **MCP** (tools), **A2A** (agent-to-agent), **ADK** (Google's framework) · shared memory & message passing



---

### Module 6 — Voice Agents & LLM Optimization

Ship an agent that talks — and survives real conversation — then make the inference behind it fast and cheap enough to run.

**Key topics:** the voice stack (STT → LLM → TTS) · turn-taking & end-of-turn detection · latency budgeting, streaming & barge-in · tool calling inside a voice loop · provider landscape (Deepgram, ElevenLabs, OpenAI Realtime, Vapi, Retell) · quantization (4-bit / 8-bit, FP4 vs. NF4) · KV caching · speculative decoding · inference metrics (TTFT, ITL, throughput)


---

## What You'll Build

This course goes beyond theory. Across the six modules you'll ship real, portfolio-ready artifacts:

| 🛠️ Artifact | What it proves |
|------------|----------------|
| 🔁 **ReAct agent** built from scratch | You understand the loop, not just a framework |
| 🤝 **Sprint Zero** — multi-agent app builder | You can orchestrate specialized subagents to a shared spec |
| 🔎 **Agentic RAG pipeline** with semantic cache | Retrieval as a decision, with real latency/cost wins |
| 🕸️ **Knowledge Graph app** + RAG-vs-KG eval | You can pick the right memory for the job and measure it |
| 🎬 **Moment RAG** — cited answers over video | Retrieval resolves to the exact moment you cite, not just a doc |
| 🎙️ **Voice agent** that handles real conversation | You can budget latency and survive barge-in |
| ⚡ **Optimized LLM deployment** | Quantization, KV caching, speculative decoding |
| ✅ **Evaluation + guardrail harness** | You ship with measurable quality and safety |

Each module ends with a working artifact you built yourself.

---

## Full Stack Projects

End-to-end, build-along projects that tie the course concepts together.

### 🚀 Sprint Zero — a multi-agent product team in your terminal

> **Point it at a product. Answer three questions. Get back a complete spec set and a working app.**

A Claude Code kit that runs a full sub-agent product team on your laptop — scoping, research, six spec docs, parallel engineering, and QA, all driven from one command. The Module 2 capstone, and a working reference for the orchestrator + subagents pattern.

```
/sprint-zero https://twenty.com  →  📋 specs  →  🤝 parallel build  →  ✅ QA  →  🟢 running app
```

- ⚙️ **Configurable** — `web-app` / `api-service` / `cli-tool` · `node-react` / `nextjs` / `python-react`
- 🔌 **Zero-setup default** — SQLite + local auth, runs straight after clone (no account, no keys)
- ⏱️ **~10–20 min** end-to-end for an MVP

[![Open Sprint Zero](https://img.shields.io/badge/▶%20Open-Sprint%20Zero-6E40C9?style=for-the-badge)](Full_Stack_Projects/Sprint_Zero)

Built by [Yousuf Alvi](https://github.com/yousuf-alvi) and [Hamza Farooq](https://www.linkedin.com/in/hamzafarooq/).

---

## About the Course

**Agent Engineering Bootcamp: Developers Edition** · ⭐ 4.8/5 (107 reviews)

**Instructor:** [Hamza Farooq](https://www.linkedin.com/in/hamzafarooq/) — Founder · Ex-Google · Professor at UCLA & UMN

A hands-on, build-every-week bootcamp for engineers who already write Python and have touched LLM APIs. Six live 2-hour sessions; you leave with the **judgment** that separates engineers who ship agents from engineers who follow tutorials.


---

*Created by [boring-bot](https://maven.com/boring-bot). Building the future of AI, one agent at a time.*
