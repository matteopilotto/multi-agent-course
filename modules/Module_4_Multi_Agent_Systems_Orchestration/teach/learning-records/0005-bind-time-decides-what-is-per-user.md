# When a value is bound decides what must be per-user

Running `peek.py`, the learner found unaided that binding `customer_email` left `action-log`'s `user_email` model-visible, and chose to rename it to one name (so `strict=True` can catch a future mismatch, which Claude added as the stronger reason). They first said the toolset loads at startup. Asked which email would be bound when no one has logged in yet, they concluded it must load at login. Then, unprompted beyond "what else must be per-user?", they reasoned that the `LlmAgent` and `Runner` must be per-user too, while the MCP client can be shared.

**Evidence:** Their Stage 3 answer bound both email names after seeing the peek output, and they correctly split startup objects from login objects.

**Implications:** Bound parameters, the "lock not a sign" idea and "who acts" now hold at the code level. The bound-param-absent-from-schema question (record 0004) is closed. A callable bound value plus a shared toolset was named as an option and rejected for concurrency risk; this comes back at Stage 9 (web UI, concurrent users). Next untested: login reading `users` without a grant.
