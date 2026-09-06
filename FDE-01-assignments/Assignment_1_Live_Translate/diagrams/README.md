# Deploy Architecture — Before / After Flycast

Two diagrams showing how the Live Translate backend is wired on Fly.io, and what
changed when we made the **Python AI service private via Flycast** so only the
gateway can reach it.

| File | State |
|---|---|
| [`architecture-before-flycast.drawio`](architecture-before-flycast.drawio) | AI service has a **public IP** — reachable by anyone on the internet |
| [`architecture-after-flycast.drawio`](architecture-after-flycast.drawio) | AI service has **no public IP** — reachable only inside the Fly org, over Flycast |

> **Open / edit:** these are draw.io files. In Lucidchart use **File → Import Diagram → Draw.io**;
> or open directly at [app.diagrams.net](https://app.diagrams.net).

---

## The cast (same in both diagrams)

- **Browser** — the provided widget / Chrome extension, running on any web page.
- **Node Gateway** `:8787` (`matteopilotto-livetranslate-gw.fly.dev`) — the edge:
  CORS, input validation, request logging, trace-id, and proxying. **Public in both diagrams** —
  it is meant to face the internet.
- **Python AI Service** `:8000` (`ai-service-python`) — the LLM call, the two-tier cache,
  and, crucially, **the provider API key**.
- **SQLite** (`translations.db`) — the persistent cache tier.
- **OpenRouter** (`google/gemini-3.1-flash-lite`) — the external LLM provider.

The numbered edges ①②③ trace one request end to end:
① browser → gateway, ② gateway → AI service, ③ AI service → LLM provider.

---

## Before — AI service publicly reachable

Splitting the backend into two services is only half the FDE habit. In the "before"
picture the AI service still has its own **public IP** (`ai-service-python.fly.dev`),
so the separation buys nothing security-wise:

- **Any client can hit `:8000` directly** — `curl`, a bot, or an attacker — completely
  **bypassing the gateway**. All the CORS / validation / rate-limiting logic lives on the
  gateway, so a direct call skips every guardrail.
- **The API key sits behind an internet-facing service.** Every unauthenticated call that
  reaches the AI service can burn your tokens (and your budget).

This is the exact gap the assignment's sample scorecard docks points for:
*"AI service left publicly reachable (no flycast)."*

## After — AI service private via Flycast

The AI service's **public IPs are released** and it gets a **private Flycast address**
(`ai-service-python.flycast`, a `private ingress` IPv6). Now:

- **The gateway is the only door in.** It reaches the AI service at
  `http://ai-service-python.flycast` over Fly's private network (6PN). The browser
  only ever touches the gateway.
- **The internet cannot route to a `.flycast` address** — the direct-hit path is
  **blocked at the private-network boundary**. The API key is no longer exposed at the edge.
- **Cost controls survive.** Flycast routes through the Fly proxy, so `auto_stop_machines`
  + `min_machines_running = 0` still work — a stopped machine **auto-starts on the next
  request**. (Plain `*.internal` would bypass the proxy and lose that wake-on-request behavior.)

### Why Flycast and not `*.internal`?

| | `*.flycast` | `*.internal` |
|---|---|---|
| Private (org-only) | ✅ | ✅ |
| Routes through Fly proxy | ✅ | ❌ (direct 6PN) |
| Auto-starts a stopped machine | ✅ | ❌ (needs `min_machines_running ≥ 1`) |
| Load-balances across instances | ✅ | round-robins all instances |

Flycast keeps the private property **and** the scale-to-zero cost savings, which is why
it's the right fit here.

---

## How this was verified (live)

- `fly ips list -a ai-service-python` → only a `private ingress` v6 address; **no public IP**.
- `curl -sf https://ai-service-python.fly.dev/health` → **fails** (not publicly reachable).
- `curl -s https://matteopilotto-livetranslate-gw.fly.dev/health` → returns
  `{"status":"ok","aiService":{"status":"ok", ...}}` — the public gateway reaches the
  private AI service, and nests its health.

The relevant config lives in
[`../backend/ai-service-python/fly.toml`](../backend/ai-service-python/fly.toml):
`force_https = false` (Flycast traffic is plain HTTP on the private network) with the
`[http_service]` block kept so the proxy can auto-start a stopped machine.
