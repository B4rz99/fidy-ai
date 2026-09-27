---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Own the requested scope through implementation, verification, review fixes, and commit.

Keep a compact checklist of the spec or tickets' acceptance criteria, linking each to its implementation and verification evidence. Keep missing behavior and unresolved review findings open even when the implemented subset passes its tests. Carry the checklist, settled decisions, and next action through compaction or handoff; resume the remaining work.

Use /tdd for behavior that benefits from test-first implementation, at the spec’s seams or existing public interfaces.

Run checks appropriate to the changed behavior and the repository’s required validation. Fix failures introduced by the change and rerun affected checks; repeat successful checks only after relevant changes.

Review the complete requested scope with /code-review. Treat actionable findings as implementation work: fix them, update the checklist, and rerun review until every active axis reports no findings, respecting the user's selected axes and stopping instructions. A reviewed partial slice or an unsuccessful fix attempt is a progress checkpoint, not task completion.

Commit your work to the current branch under repository conventions. Intermediate commits do not close open acceptance criteria. Completion means the requested behavior is implemented, relevant checks pass, review findings are resolved, and the work is committed. If the request includes a PR or merge, continue through that authorized workflow.

Continue resolving failures within the authorized scope. Yield before completion only for a user-requested pause or a concrete blocker requiring unavailable access, authorization, or a user decision. For a blocker, state the unresolved requirement, what you tried, and exactly what input or capability is needed; continue any independent work that remains possible.
