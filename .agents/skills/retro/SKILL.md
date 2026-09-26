---
name: retro
description: "Conduct a retrospective on a coding session."
disable-model-invocation: true
---

The user has asked for a **retrospective**. Suggest changes to the coding agent's **environment** that would improve future runs, not changes to the product code.

## Steps

1. Call the Skill tool with `writing-for-agents` for the writing style guide.

2. Read the primary sources for the session the user specifies. If no session is specified, use the current session. If the relevant session history is unavailable, say what sources you could inspect and ask for the missing context rather than guessing.

   Session history may contain credentials, personal information, or financial data. Do not reproduce or persist those values in findings; redact them and include only the minimum evidence needed to explain a candidate.

3. Look for environment improvements in these categories:

   - **Navigation**: Were the right files hard to find, or were dependencies between files hidden? Would a navigation pointer help? Use when the session spent time locating information.
   - **Automated checks**: Could a deterministic check have caught an agent mistake? First inspect the repository's actual check scripts and CI workflows. An existing but unwired or silently broken check is the finding, not a duplicate check. A repository with no guardrail running its lint, typecheck, or test command is itself a missed opportunity.
   - **Coding standards**: Should the reviewer be given a rule, or should an existing rule be clarified? Classify the miss first. A mechanical rule (fixed syntax, banned API, import shape, file location) belongs in a deterministic check—prefer the repo's linter, a hook, or CI. Reserve standards documents for genuine judgment calls that a guardrail cannot substitute for. Put review rules where the repo's review workflow actually reads them.
   - **Global steering**: Are large `AGENTS.md` or `CLAUDE.md` files carrying instructions better placed in coding standards or automated checks? Keep steering files focused on navigation pointers.
   - **Tool economy**: Were expensive or token-inefficient tool calls repeated? Is there a concrete tool or command improvement?
   - **No-ops**: Did a steering instruction fail to change the agent's behavior? Look for instructions that are stale, redundant, or too weak to affect the default.
   - **Information access**: Was crucial information unavailable that could be made available safely, such as development logs or read-only third-party data?

4. Present the strongest candidates first. For each, state the observed evidence (redacted), the environment change that could prevent or reduce the problem, and why it belongs in that environment location. Distinguish confirmed gaps from hypotheses. Do not edit files, create issues, or make code changes unless the user asks.

## Reference

### Implementation vs review

Implementation has the most context pressure: exploration, coding, and debugging all happen there. Review receives a diff and usually needs less exploration. Place coding-standard enforcement in the review process where appropriate; let implementation focus on building the requested behavior. Mechanical violations still belong in deterministic checks, not review prose.

### Candidate locations

- `AGENTS.md` / `CLAUDE.md`: navigation pointers and indispensable always-loaded steering, kept brief.
- Coding standards: genuine judgment calls that cannot be replaced by a guardrail.
- Linter, pre-commit hook, or CI: mechanically decidable rules, using the cheapest existing enforcement point.
- Existing docs: reference material that can be pointed to rather than copied into steering files.
- Tooling or information access: a concrete way to make future work safer or more efficient.
