# fidy-ai

## Toolchain

- **Runtime / package manager:** [Bun](https://bun.sh) (`packageManager` pinned in `package.json`).
  `bunfig.toml` uses a hoisted linker and a 7-day supply-chain delay on new releases.
- **Linter:** [oxlint](https://oxc.rs) — base config plus a stricter `.oxlintrc.strict.json`.
- **Formatter:** [oxfmt](https://oxc.rs) — configured in `.oxfmtrc.json`.
- **Type checker:** TypeScript (`tsconfig.json`, strict).
- **Git hooks:** [lefthook](https://lefthook.dev) — lint/format on staged files and a
  commit-message convention check.

### Common scripts

| Command                | What it does                      |
| ---------------------- | --------------------------------- |
| `bun run lint`         | oxlint (base rules)               |
| `bun run lint:strict`  | oxlint with the strict config     |
| `bun run format`       | Format the repo with oxfmt        |
| `bun run format:check` | Verify formatting without writing |
| `bun run typecheck`    | `tsc --noEmit`                    |
| `bun run verify`       | lint + format:check + typecheck   |

## Commit convention

Commit messages are enforced by the git hooks and must follow:

```
type(scope): summary

- body bullet
- another body bullet
```

`type` is one of `feat|fix|refactor|chore|docs|test|perf|ci`. `scope` is required and must be
one of a fixed allowlist:

| scope      | when to use                             |
| ---------- | --------------------------------------- |
| `backend`  | server, API implementation, logic       |
| `frontend` | web dashboard / UI                      |
| `ai`       | hosted agent, prompts, LLM routing      |
| `api`      | agent-legible API surface & conventions |
| `whatsapp` | WhatsApp channel integration            |
| `payments` | payment rails (Wompi / ePayco)          |
| `auth`     | onboarding, consent, login              |
| `db`       | schema / migrations                     |
| `repo`     | repo-wide tooling, config, hooks, CI    |
| `deps`     | dependency bumps                        |
| `docs`     | documentation                           |

Body lines must be `-` bullets — non-bullet lines (including trailers) are rejected. The hook
prints this scope table on failure so it can be corrected without leaving the terminal.

### Merges

PRs are **squash-only** (merge commits and rebase are disabled). The squashed commit on `trunk`
takes its subject from the **PR title**, so the PR title must follow the same
`type(scope): summary` convention — a `PR Title` CI check enforces this. Every `trunk` commit
therefore reads `type(scope): summary (#N)`.

## CI

Pull requests targeting `trunk` run lint, format, typecheck, and security scans (Gitleaks,
TruffleHog, Semgrep, and Fluid Attacks SS/SAST/SCA). A `Required Checks` gate must pass before
a PR can merge.
