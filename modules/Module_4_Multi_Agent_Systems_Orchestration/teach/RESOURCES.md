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
- [ADK docs](https://adk.dev/)
  Google's Agent Development Kit: `LlmAgent`, workflow agents, `Runner`, sessions, events. Use for: Stage 3, 4 and 7. *(Pages not yet read. Verify before the ADK lesson.)*
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
- A2A and ADK primary docs not yet read in depth. Read them before lessons 3 and 4.
- (resolved 2026-11-07) `--enable-api` exists in Toolbox 1.16.0 (`--help`); also `toolbox invoke` runs a tool directly. Use `--allowed-hosts`/`--allowed-origins` to silence the DNS-rebinding warnings.
