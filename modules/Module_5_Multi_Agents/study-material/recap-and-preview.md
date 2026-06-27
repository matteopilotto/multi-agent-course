# Module 05 — Recap & Preview (15-Minute Warm-Up)

<!-- INSTRUCTOR: A quick "before class" bridge. Recaps Module 04 and previews Module 05.
     Designed for a ~15-min review with Claude right before the live session.
     Note: Module 04 (AI Evaluation) recap is best-effort — its study-material isn't authored
     yet, so keep the recap light and lean on the course arc. -->

## Last time (Module 04 — AI Evaluation)
The big ideas you should still have in your head:
- Production **guardrails** (e.g. Llama Guard) sit around the model to catch unsafe input/output.
- **Trajectory vs. outcome** evaluation — judge the *path* an agent took, not just the final answer.
- You can't ship what you can't measure: evaluation is what makes an agent safe to put in front of users.

**Quick gut-check:** What's the difference between evaluating an agent's *outcome* and its
*trajectory*, and why might a right answer reached the wrong way still be a problem?

## How it connects
Module 4 was about *judging* one agent's behavior. Module 5 is about *coordinating many* — and
notice the capstone's Security Judge is exactly a guardrail from Module 4, now running as its own
networked agent. Evaluation becomes a service in the pipeline, not an afterthought.

## Coming up (Module 05 — Multi-Agent Systems & the Protocol Layer)
What you'll be able to do after today:
- Explain why a **protocol layer** beats hand-written glue once you have more than one agent or tool
- Use **MCP** to give an agent tools it discovers at runtime (instead of hard-coding them)
- Run agents as **A2A** services that publish an agent card and talk over JSON-RPC
- Define agents with **ADK** — `LlmAgent`, `SequentialAgent`, the `Runner`
- Trace the capstone: sanitize → A2A Judge → agent (+ MCP tools, Mem0) → A2A Mask

**Watch for:** the one-sentence rule that ties it together — **ADK defines, A2A connects, MCP
feeds.** If you can say what each layer does for the support agent, the whole system clicks.

## If you only remember one thing walking into class
> Multi-agent systems scale through *standards*, not glue: ADK defines the agents, A2A connects
> them over the network, MCP feeds them tools — each layer swappable without touching the others.
