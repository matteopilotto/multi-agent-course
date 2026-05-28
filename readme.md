# Agent Engineering Bootcamp: Developers Edition

Welcome to the official course repository for **Agent Engineering Bootcamp: Developers Edition**.

This repo is for **anyone** and contains all code, exercises, templates, and project materials used throughout the course.

**What makes this different?**
A structured 4-part journey from deployment efficiency to validated action. Master the complete agentic systems stack: Agent Harness and ReAct orchestration, LLM optimization, hybrid memory models (RAG + Knowledge Graphs), and production-grade evaluation frameworks. Build agentic systems that are reliable, observable, fast, safe, and production-ready.

🔗 [Visit course page](https://maven.com/boring-bot/advanced-llm) • 💾 [Save $200 with code 200OFF](https://maven.com/boring-bot/advanced-llm?promoCode=200OFF)

---
<img width="2752" height="auto" alt="unnamed-3" src="assets/image.png" />


## Quick Links

### Course Structure: From Efficiency to Action

- [Module 1: The Agent Loop](#part-1-deployment--efficiency)
- [Module 2: LLM Quantization and KV Caching](#part-1-deployment--efficiency)
- [Part 2: Retrieval & Memory](#part-2-retrieval--memory)
- [Part 3: Acting & Control](#part-3-acting--control)
- [Part 4: Evals as Engineering Discipline](#part-4-evals-as-engineering-discipline)
- [Technology Stack](#technology-stack)
- [What You'll Build](#what-youll-build)

---

## Recommended Resource

If you'd like to deepen your understanding of building LLM applications, refer to this book:

[**Build LLM Applications from Scratch**](https://www.manning.com/books/build-llm-applications-from-scratch)

---

## How to Use This Repo

- This repo contains supplemental content for the course. Content is organized **week by week**, aligned with live sessions and project milestones.
- **Google Colab Pro** is the preferred environment for running notebooks.
- You may also **clone the repo locally** and run notebooks using Jupyter or your IDE.
- Each notebook includes its own dependencies via `!pip install` — there is **no global `requirements.txt`**.

---

## Cloning the Repository (Optional)

```bash
git clone https://github.com/hamzafarooq/multi-agent-course.git
cd multi-agent-course
python3 -m venv .venv
source .venv/bin/activate
```

## Course Curriculum

> **The Agentic Systems Roadmap: From Efficiency to Action**

This course follows a structured path from building performant AI systems to ensuring they act safely and effectively in production.

---

### Part 1: Deployment & Efficiency

**Building the Performance & Memory Engine**

Focus on Quantization and KV Caching to define what is actually deployable in the real world.

#### Key Topics:
- LLM Deployment and Hosting
- Quantization methods (4-bit, 8-bit)
- KV Caching optimization
- Speculative Decoding
- Mixture of Experts

#### Notebooks:

TextSTreamer: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_2/Quantization/TextStreamer_Meta_Llama_3_1_8B_Instruct.ipynb)

Bitsnbytes Quantization: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_2/Quantization/Bitsnbytes_4bit_Quantization.ipynb)

---

### Part 2: Retrieval & Memory

**Hybrid Memory Models**

Integrates RAG for unstructured data and Knowledge Graphs for structured, symbolic reasoning.

#### Key Topics:
- Naive RAG vs Agentic RAG
- Agentic RAG Components
- Semantic Cache implementation
- Knowledge Graphs for structured reasoning
- GraphRAG at scale
- Text-to-Cypher conversion with LLMs
- RAG vs Knowledge Graph Evaluation

#### Notebooks:

Upload Data to Qdrant: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_1/Agentic_RAG/Upload_data_to_Qdrant_Notebook.ipynb)

Agentic RAG: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_1/Agentic_RAG/Agentic_RAG_Notebook.ipynb)

Semantic Cache: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_3/Semantic_Cache/Semantic_cache_from_scratch.ipynb)

Knowledge Graphs Basic Version: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_4/Knowledge_Graphs/Knowledge_Graphs_Basic_Version.ipynb)

Knowledge Graphs Advanced Version: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_4/Knowledge_Graphs/Knowledge_Graphs_Advanced_Version.ipynb)

**📊 Featured Project: RAG vs Knowledge Graph Comparison Framework**

A production-ready Streamlit application that objectively compares RAG and Knowledge Graph approaches using LLM-based evaluation. Includes interactive graph visualizations showing the exact data path used for each answer.

[View Full Documentation →](Module_4_Knowledge_Graphs/)

**Interactive Demo:**

```bash
cd Module_4_Knowledge_Graphs
python setup.py  # One-time setup
streamlit run app.py
```

---

### Part 3: Acting & Control

**Intelligence Becomes Action**

Uses ReAct loops and Guardrails to ensure agents reason, act, and coordinate safely.

#### Key Topics:
- Building LLM Agents from scratch
- ReAct (Reasoning + Acting) patterns
- Multi-Agent Orchestration with ADK & MCP
- AI Agent Frameworks (smolagents, AutoGen, CrewAI)
- Production Guardrails (Llama Guard)
- Safety and control mechanisms

#### Notebooks:

AgentPro Starter Code: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_5/Agents/AgentPro%20Starter%20Code.ipynb)

Agent Pro from Scratch [old version]: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_5/Agents/Agent%20Pro%20from%20Scratch%20%5Bold%20version%5D.ipynb)

Agent Pro ReAct: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_5/Agents/Agent%20Pro%20ReAct.ipynb)

Smol Agents: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_5/Agents/Smol%20Agents.ipynb)

ADK A2A MCP: [![GitHub Folder](https://img.shields.io/badge/View%20on-GitHub-blue?logo=github)](https://github.com/hamzafarooq/multi-agent-course/tree/main/Module_6/A2A%20ADK%20MCP)

MCP (non-adk): [![GitHub Folder](https://img.shields.io/badge/View%20on-GitHub-blue?logo=github)](https://github.com/hamzafarooq/multi-agent-course/tree/main/Module_6/MCP%20(non-adk))

Llama Guard: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_6/Guardrails/Llama%20Guard.ipynb)

---

### Part 4: Evals as Engineering Discipline

**Closing the Loop**

Validates the entire stack by measuring and optimizing efficiency, reasoning quality, and safety.

#### Key Topics:
- LLM-based evaluation frameworks
- RAG vs Knowledge Graph comparison methodologies
- Safety evaluation and jailbreak testing
- Production monitoring and validation
- Performance benchmarking

#### Notebooks:

Ollama jailbreak: [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/hamzafarooq/multi-agent-course/blob/main/Module_6/Ollama/Mistral%20Llama%203.1%20and%20Llama%203.2%20jailbreak.ipynb)

---

## Technology Stack

This course uses the following tools and services:

| Area                  | Tools / Frameworks                                   |
|-----------------------|------------------------------------------------------|
| **LLM Access**        | Ares API (via Traversaal.ai), OpenAI GPT-4o-mini     |
| **Agent Frameworks**  | ADK, A2A, CrewAI                                     |
| **Vector Search**     | FAISS (Colab), OpenSearch (optional)                 |
| **Graph Databases**   | Neo4j Aura, NetworkX                                 |
| **Memory & Caching**  | Redis Cloud (recommended setup)                      |
| **Web Interfaces**    | Streamlit, FastAPI                                   |
| **Visualizations**    | Pyvis, Plotly, Interactive Graph Rendering           |
| **Notebooks**         | Google Colab Pro (preferred), Jupyter (optional)     |
| **Deployments (Optional)** | AWS Lambda, Step Functions, FastAPI             |
| **Language**          | Python 3.10+                                         |

> You don't need to pre-install anything locally.
> All key dependencies are included in each notebook.
g
---

## What You'll Build

This course goes beyond theory. You'll build production-ready systems across four key phases:

### Phase 1 & 2: Building the Performance & Memory Engine
- **Optimized LLM Deployments** with quantization and KV caching
- **Agentic RAG Systems** with advanced retrieval and semantic caching
- **Knowledge Graph Applications** with RAG vs KG evaluation framework
- **Hybrid Memory Models** combining structured and unstructured data

### Phase 3 & 4: From Intelligence to Validated Action
- **ReAct Agent Systems** that reason and act autonomously
- **Multi-Agent Workflows** with ADK, A2A, and CrewAI orchestration
- **Production Guardrails** for safe AI deployment (Llama Guard)
- **LLM-based Evaluators** for comprehensive system validation
- **Interactive Dashboards** using Streamlit for real-time demos

Each module includes hands-on projects you can showcase in your portfolio.

---

## Student Feedback (Beta Cohort)

> "Finally a course that moves past theory and teaches **how to build AI systems that work**."
> "Everything was practical — I now know how to apply RAG and agents in real products."

---

## Ready to Master Multi-Agent Systems?

<a href="https://maven.com/boring-bot/advanced-llm?promoCode=200OFF">
  <img src="Module_4_Knowledge_Graphs/course_img.png" alt="Agent Engineering Bootcamp" width="600">
</a>

### Agent Engineering Bootcamp: Developers Edition

**Rating:** ⭐⭐⭐⭐⭐ 4.8/5 (96 reviews)

**Your Instructor:** Hamza Farooq
*Founder | Ex-Google | Professor at UCLA & UMN*

**What You'll Learn:**
- ⚡ Optimize LLM deployment with quantization, KV caching, and speculative decoding
- 🧠 Build hybrid memory systems combining RAG and Knowledge Graphs
- 🤖 Create ReAct agents with multi-agent orchestration (ADK, MCP)
- 🛡️ Implement production guardrails and safety mechanisms
- 📊 Master evaluation frameworks that validate efficiency, reasoning, and safety
- 💼 Deploy production-ready AI systems with modern tooling

**Course Highlights:**
- 4-part structured curriculum: From Efficiency to Action
- 6 weeks of intensive, hands-on learning
- Live sessions with industry expert (Ex-Google, UCLA & UMN Professor)
- Production-ready code and templates for every phase
- Real-world case studies and architectures
- Certificate of completion

### [🎓 Enroll Now - Save $200 with code 200OFF →](https://maven.com/boring-bot/advanced-llm?promoCode=200OFF)

---

## Let's Build AI Systems That Survive the Real World

This repository is for enrolled students only and contains all code, exercises, and project materials.

**Your instructor**: [Hamza Farooq](https://www.linkedin.com/in/hamzafarooq/)
**Created by** [boring-bot](https://maven.com/boring-bot)

*Building the future of AI, one agent at a time.*
