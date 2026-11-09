# Multi-agent systems and the protocol layer: Resources

## Knowledge

### MCP
- [MCP: Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture)
  The official explanation of host, client and server, JSON-RPC 2.0, and the stdio and Streamable HTTP transports. Use for: who is who in an MCP system.
- [MCP spec (latest, 2026-07-28): Tools](https://modelcontextprotocol.io/specification/latest/server/tools)
  Normative `tools/list` and `tools/call` shapes, the "model-controlled" design, `isError` vs JSON-RPC errors, and annotations treated as untrusted. Use for: exact wire shapes.
- [MCP spec (latest): Overview](https://modelcontextprotocol.io/specification/latest)
  Note: the 2026-07-28 revision is stateless (no `initialize` handshake; `_meta` on every request, `server/discover`). Older tutorials show the 2025 handshake.

### MCP Toolbox for Databases (the assignment's MCP server)
- [googleapis/mcp-toolbox (README)](https://github.com/googleapis/mcp-toolbox)
  Renamed from `genai-toolbox`. Shows the current flat `tools.yaml` format (one YAML document per resource with `kind:`). Use for: config syntax and how to start the server.
- [mcp-toolbox.dev: postgres-sql tool](https://mcp-toolbox.dev/integrations/postgres/tools/postgres-sql/)
  `$1`, `$2` placeholders map to the parameters in order. Use for: writing Stage 2's tools.
- [mcp-toolbox.dev: Python SDK, toolbox-core](https://mcp-toolbox.dev/documentation/connect-to/toolbox-sdks/python-sdk/core/)
  `ToolboxClient`, `load_toolset`, `load_tool`, and bound parameters (a value or a callable). Speaks MCP by default. Use for: Stage 2 and 3.

### A2A
- [A2A protocol: latest specification](https://a2a-protocol.org/latest/specification/)
  Normative spec (v1.0; source of truth is `a2a.proto`). Agent cards, tasks, messages, and the JSON-RPC, gRPC and REST bindings. Use for: Stage 6 and 8. *(Not yet read closely. Verify before the A2A lesson.)*
- [A2A quick reference for agents](https://a2a-protocol.org/llms-reference.txt)
  Condensed v1.0 summary.

### ADK
- [ADK: Runtime Event Loop](https://adk.dev/runtime/event-loop/)
  The `Runner` as "central coordinator for a single user invocation"; `run_async` is the main entry point; the agent pauses after each `yield`. Use for: what the Runner does (lesson 0002's primary source).
- [ADK: Simple agents with LlmAgent](https://adk.dev/agents/llm-agents/)
  `LlmAgent` (alias `Agent`): `model` (required), `instruction`, `description`, `tools`. Use for: Stage 3's agent.
- [ADK: Session](https://adk.dev/sessions/session/)
  One session = one conversation thread (`id`, `userId`); `InMemorySessionService` loses everything on restart; `create_session` is awaited; missing session → `SessionNotFoundError` unless `auto_create_session=True`.
- [ADK: Events](https://adk.dev/events/)
  `author`, `content`, `partial`, `get_function_calls()`, `get_function_responses()`, `is_final_response()`. Does **not** document `usage_metadata` (a field in the 2.13.0 source). Use for: Stage 4's renderer.
- [ADK: Function tools](https://adk.dev/tools-custom/function-tools/)
  A function in `tools` is wrapped as a `FunctionTool`; signature + docstring become the schema; type hint without default = required.
- [ADK: MCP Toolbox for Databases](https://adk.dev/integrations/mcp-toolbox-for-databases/)
  Uses `ToolboxToolset` from `toolbox-adk`; bound params "are hidden from the model". The build env has `toolbox-core` 1.4.0 instead, whose callables ADK wraps directly.
- Installed source (conda env `customer-support`: google-adk 2.13.0, toolbox-core 1.4.0) beats docs when they differ. Verified there: `Event.is_final_response()` is also true for error events; `load_toolset(strict=True)` raises if a bound param goes unused by any tool.
- [ADK + Phoenix integration](https://adk.dev/integrations/phoenix/)
  OpenInference instrumentation for ADK into Phoenix. Use for: Stage 5.

### In this repo
- `../Assignment_3_Customer_Support/`: SPEC (requirements), TECHNICAL (ten stages), THRESHOLDS (every number)
- `../advance-customer-support-agent-feature-A2A-MCP-ADK/`: reference build. Read it, don't copy it; it breaks the spec on purpose (SPEC §15).
- `../study-material/lesson.md`: the module's conceptual companion

## Wisdom (Communities)
- [MCP GitHub Discussions](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions): where spec changes get argued. Use for: "why is it designed this way?"
- [googleapis/mcp-toolbox issues](https://github.com/googleapis/mcp-toolbox/issues): Toolbox bugs and config questions
- [Arize community](https://community.arize.com/): Phoenix and OpenInference tracing questions
- The cohort itself: compare `DESIGN.md` decisions with classmates. Two people who chose differently is the best feedback there is.

## Gaps
- A2A primary docs not yet read in depth. Read them before lesson 0004. (ADK pages read 2026-11-07 for lesson 0002.)
- ADK Python API reference (https://adk.dev/api-reference/python/) not read; the docs pages show no Python `Runner(...)` example, so constructor args were taken from the installed source.
- (resolved 2026-11-07) `--enable-api` exists in Toolbox 1.16.0 (`--help`); also `toolbox invoke` runs a tool directly. Use `--allowed-hosts`/`--allowed-origins` to silence the DNS-rebinding warnings.
