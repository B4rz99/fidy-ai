---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Research runs in the current session by default; when delegated, use a Herdr-managed Pi worker with OpenAI Codex gpt-5.6-luna at max reasoning effort.
---

Conduct the research in the current agent session by default. Delegate only when the caller requests AFK or parallel research, or a parent workflow such as `/wayfinder` requires a research worker. Any delegated worker must run in its dedicated Herdr worktree as:

```bash
pi --model openai-codex/gpt-5.6-luna --thinking max
```

Use no substitute model or reasoning level. The worker follows the same steps below in its own session and returns the report path plus unresolved questions.

1. Locate the repo's convention for research notes and choose the destination Markdown path. This step is complete when the path is established without overwriting unrelated work.
2. Trace the question to **primary sources**: official documentation, source code, specifications, or first-party APIs. Use secondary sources only to discover primary ones. This step is complete when every material finding is supported by the source that owns it and conflicting evidence is resolved or recorded.
3. Write one self-contained Markdown report at the chosen path. Cite each material claim with a URL or repository path and line range; distinguish sourced facts from conclusions. This step is complete when a reader can verify every material claim from its citation.
4. Report the file path and any unresolved questions. Research is complete only when the file exists and all material claims meet the citation criterion.
