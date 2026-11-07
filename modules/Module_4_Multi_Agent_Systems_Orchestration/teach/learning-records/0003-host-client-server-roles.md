# Host, client and server are separate roles; the host is the go-between

At first the learner saw host and client as the same thing, because in a single-server setup (Cursor + Jira MCP) nothing tells them apart. Pseudocode with two servers made the difference visible. They then correctly counted one host, two clients and two servers for Cursor + Jira + GitHub, and stated that the model never talks to a server. Remaining imprecision: they said model and server communicate "through the client". It's the host that carries messages (model ⇄ host ⇄ client ⇄ server), and the client never sees the model.

**Evidence:** Correct counts on the Jira + GitHub check, without hints.

**Implications:** This is the course-wide "who acts vs. who decides" weak spot again. In Assignment 3, keep asking "which role does this line of code play?". The pipeline is the host, so guards, approval and tracing go there, not in the client or the server.
