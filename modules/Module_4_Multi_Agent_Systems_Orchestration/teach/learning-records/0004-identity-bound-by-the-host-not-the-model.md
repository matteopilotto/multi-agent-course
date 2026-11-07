# Identity comes from the host and is bound into the tool, never filled by the model

With Socratic prompts and no reveal, the learner reasoned to the bound-parameter pattern: the tool function takes the email, the model's schema leaves it out, and the harness adds it programmatically, "so the model can't put in any value". They got there in three steps: (1) ownership check in the tool, (2) identity known only by the harness, which ran the login, (3) keep the email out of what the model writes. This is SPEC R-1/M-4/M-5, and toolbox-core's `bound_params`.

**Evidence:** Their Stage 2 "before" answer was "in the tool, check the order belongs to Alice". When asked how the tool knows it's Alice, they first answered "the harness checks identity" and then proposed removing the parameter from the model's schema and having the harness inject it.

**Implications:** "Enforced" (a lock, not a sign) is now a usable concept; reuse it for the guards (Stage 6–8: a fail-open `except` is a sign, not a lock). Not yet verified: whether toolbox-core removes a bound param from the model-visible schema. They should check it in Stage 3.
