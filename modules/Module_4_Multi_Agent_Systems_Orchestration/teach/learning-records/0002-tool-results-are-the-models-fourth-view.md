# Tool results are the model's fourth view of a tool

The learner reasoned correctly, without help, that the model sees only a tool's name, description and input schema, so a secret kept in the implementation (key in `.env`) never reaches the model whether the tool lives in a local dict or on an MCP server. They missed that the tool's *return value* also goes into the model's context. A raw exception that echoes a request URL with an API key in it leaks the key into the context, the reply and the trace. They took this on board once told; they have not applied it yet.

**Evidence:** Unprompted, they weighed dict vs. MCP for a paid-key carrier tool and argued both sides (key → server; single consumer → dict).

**Implications:** Check for this in Stage 2 (Toolbox results are a JSON string inside JSON) and in Stage 4 (unwrapping and emitting tool results). Ask "what does the model see from this tool?" before giving hints. The dict-vs-server rule they now have: dict while there's one consumer; server once a second consumer appears or central control (spending cap, key rotation, audit) is needed.
