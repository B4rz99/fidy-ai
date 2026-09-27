---
name: ask-matt
description: Ask which skill or flow fits your situation. A router over the skills in this repo.
disable-model-invocation: true
---

# Ask Matt

Recommend the smallest available skill or flow that fits the user's situation. Check the active skill catalog and repository tracker conventions before naming dependencies; personal installations may differ. This is a routing conversation, not an instruction to execute every stage.

| Situation                                                | Route                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Stress-test an idea                                      | `grilling`; use `grill-with-docs` when domain decisions should be recorded |
| Resolve domain language or an architectural tradeoff     | `domain-modeling`                                                          |
| Answer a question from primary sources                   | `research`                                                                 |
| Settle a design question with something runnable         | `prototype`                                                                |
| Explore a large effort with unresolved decisions         | `wayfinder`                                                                |
| Turn settled decisions into a spec                       | `to-spec`                                                                  |
| Split a spec into dependent implementation slices        | `to-tickets`                                                               |
| Implement a scoped spec or ticket                        | `implement`                                                                |
| Implement an approved ticket graph with isolated workers | `implement-spec` (requires Herdr)                                          |
| Build behavior test-first                                | `tdd`                                                                      |
| Diagnose a difficult failure                             | `diagnosing-bugs`                                                          |
| Design deeper module interfaces                          | `codebase-design` or `improve-codebase-architecture`                       |
| Review changes or prepare a PR                           | `code-review` or `opening-a-pr`                                            |
| Improve the working environment after a session          | `retro`                                                                    |
| Explain visually or teach over several sessions          | `show-me` or `teach`                                                       |
| Transfer work to another session                         | `handoff`                                                                  |
| Write agent instructions                                 | `writing-for-agents`                                                       |

Recommend only skills available in the current environment. If a needed capability is absent, explain the gap and suggest a direct approach. Read the chosen skill for its current workflow rather than copying its procedure into this router.

For a typical feature, use only the stages still needed: clarify unresolved decisions, record a spec if useful, then implement and validate. Research runs in the current session by default; delegate only when requested or required by the selected workflow. Keep settled decisions and acceptance criteria with the work so it can survive compaction or handoff.

When deciding whether to continue, compact, or hand off, read [PHASE-BOUNDARIES.md](PHASE-BOUNDARIES.md).
