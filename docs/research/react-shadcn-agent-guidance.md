# React and shadcn agent-guidance strategy

_Research snapshot: 2026-08-13. Primary sources: the exact React 19.2.8 tag and package, official React and shadcn documentation, the three proposed skill repositories, and their file histories._

## Executive recommendation

Keep the agent setup clean:

- **Keep the exact React 19.2.8 source under `.repos/react`.** Pair it with official React documentation and the installed public contract rather than treating internals as application examples.
- **Do not add the full shadcn repository under `.repos/`.** The relevant component implementations become project-owned source when the pinned CLI adds them.
- **Do not install `react-best-practices` or `react-view-transitions`.**
- **Use the official shadcn skill.** Its project-aware CLI workflow is more useful than a separate local pattern note. The repository accepts that this upstream skill invokes `shadcn@latest`; generated diffs and project tests remain the review boundary.

The right authority differs by library:

| Area                                       | Authority order                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| React public API and application practices | Installed package/types → official `react.dev` API and Learn pages → exact-tag source and tests for runtime behavior                             |
| shadcn                                     | Project-owned generated component source → `components.json` → pinned CLI `info`/`docs`/`view`/`--diff` output → selected primitive's types/docs |
| Effect                                     | Existing exact checked-out source and source-cited `.patterns/` notes                                                                            |

This is not a universal claim that source is always best. Source is best for precise behavior and testing seams. Public docs are often better for application-level React guidance, and project-local generated code plus the CLI is better for shadcn because shadcn is a code-distribution system rather than a traditional runtime component package.

## React: retain the exact release as a research reference

### Verified facts

The application currently pins React and React DOM 19.2.8 (`package.json:46-47`), and `.repos/react` is the squash-imported exact `v19.2.8` source at commit `1dd4ecbdabf826f527fc9a58c05ea70375b7d170`. [Official tag reference](https://api.github.com/repos/facebook/react/git/ref/tags/v19.2.8) · [tagged package manifest](https://github.com/facebook/react/blob/v19.2.8/packages/react/package.json#L1-L45)

The repository directly declares exact, policy-eligible `@types/react` and `@types/react-dom` versions (`package.json:54-55`). These declarations are the TypeScript-facing public contract; source code does not substitute for them.

React's official documentation separately publishes application-facing Rules of React, Hook guidance, and performance caveats. For example, it describes `useMemo` as a performance optimization rather than a semantic guarantee and explains that React Compiler can reduce manual memoization. [Official `useMemo` reference](https://react.dev/reference/react/useMemo) · [Rules of React](https://react.dev/reference/rules) · [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)

The implementation checkout is not automatically an application-practice guide. At the exact stable tag, the unbuilt source exports view-transition symbols under `unstable_*` names even though the public docs classify the APIs as Canary/Experimental. Agents must understand feature flags and release builds before inferring public API availability from implementation files. [React 19.2.8 `ReactClient.js`](https://github.com/facebook/react/blob/v19.2.8/packages/react/src/ReactClient.js#L124-L130) · [official `<ViewTransition>` channel notice](https://github.com/reactjs/react.dev/blob/main/src/content/reference/react/ViewTransition.md#L1-L14)

### Conclusion

Retain the exact-tag squash subtree because it makes scheduler, reconciler, Suspense, Strict Mode, renderer tests, and feature gates locally discoverable. Keep `.patterns/react.md` as the short index that translates those findings into application guidance. Derive that note from the public API, official React docs, exact source and tests, and measured project failures—not by treating React's own internals as example application components.

## shadcn: local generated code and CLI beat a source subtree

### Verified facts

shadcn explicitly says it is not a traditional component library: it is a way to build the application's own component library, based on open code, composition, and a CLI/registry distribution model. [Official introduction](https://ui.shadcn.com/docs)

Its CLI can inspect the current project, obtain component-specific documentation, preview registry files, dry-run additions, and show per-file diffs. [Official CLI `docs`, `info`, `view`, `--dry-run`, and `--diff` reference](https://ui.shadcn.com/docs/cli)

The first-party skill correctly centers those project-aware operations. It injects or requests `shadcn info --json`, requires component-specific `docs`, and recommends `--dry-run`/`--diff` rather than copying raw GitHub files. [Official skill project context and principles](https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/SKILL.md#L12-L28) · [docs workflow](https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/SKILL.md#L169-L176) · [update workflow](https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/SKILL.md#L196-L209)

The skill is genuinely maintained alongside the product: its file history contains changes for current CLI, preset, registry, chat, and Base UI behavior rather than only repository-wide maintenance commits. [Official skill history](https://github.com/shadcn-ui/ui/commits/main/skills/shadcn/SKILL.md)

The skill authorizes and repeatedly mandates `npx`, `pnpm dlx`, or `bunx` with `shadcn@latest`. [Official skill frontmatter and runner rule](https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/SKILL.md#L1-L17) The repository otherwise uses exact dependencies admitted through its seven-day package release delay (`bunfig.toml:1-11`). Installing the skill therefore makes its `@latest` runner an explicit, narrowly scoped exception rather than a general dependency-policy precedent.

The skill also encodes broad house-style rules such as “className for layout only,” mandatory component substitutions, and “implement all applicable” composition patterns. These may be good shadcn defaults, but they are design-system policy rather than immutable React or accessibility semantics. [Official styling rules](https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/rules/styling.md) · [official composition rules](https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/rules/composition.md)

### Conclusion

Do not clone `shadcn-ui/ui` under `.repos/`. Its `main` branch represents many templates, bases, styles, registries, docs, and CLI internals, while the source that actually matters after installation is the component code owned by this application. A moving `main` snapshot can also diverge from the CLI and already-generated files.

The official shadcn skill is installed under `.pi/skills/shadcn`, with source metadata in `skills-lock.json`. It reads `components.json`, uses component-specific CLI documentation, previews additions and updates, and directs agents to inspect generated files. Those capabilities make a separate `.patterns/shadcn.md` redundant.

The skill's styling rules are shadcn design-system conventions rather than universal Tailwind laws. They favor semantic theme tokens, built-in variants, standard component composition, `gap-*`, `size-*`, and project-selected icons. Some rules also make stronger product-level choices—for example, reserving `className` for layout, requiring shadcn wrappers instead of equivalent custom markup, and selecting specific controls by option count. The project adopts the skill's rules as its house style. If an explicit product requirement conflicts, surface the conflict rather than silently deviating from the skill.

The exact, policy-eligible shadcn CLI remains available through `bun run shadcn` (`package.json:17`, `package.json:62`). The installed upstream skill intentionally uses `shadcn@latest`; this is an explicit exception for skill-directed CLI execution, not a change to dependency pinning or the seven-day package-admission policy.

### Base selection for a new project

Use **Base UI** for this new SPA. In July 2026, shadcn made Base UI the default for new projects, `shadcn/create`, and its documentation. Its stated reasons were that Base UI was stable at 1.6.0 with more than six million weekly downloads, continued adding components, powered shadcn's own new projects, and was selected over Radix two to one by new `shadcn/create` projects. [Official Base UI default announcement](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)

This recommendation is not an accessibility judgment against Radix. Base UI says it implements WAI-ARIA keyboard patterns, focus management, and testing across browsers, devices, platforms, and screen readers. Radix likewise implements WAI-ARIA patterns, focus management, and keyboard navigation. [Base UI accessibility](https://base-ui.com/react/overview/accessibility) · [Radix Primitives introduction](https://www.radix-ui.com/primitives/docs/overview/introduction)

Radix remains mature, production-used, and fully supported; shadcn explicitly says existing Radix applications do not need to migrate. It remains the better choice when an existing application, local component library, or required integration already depends on Radix APIs. This application has no such migration or compatibility cost. The installed CLI also identifies `base-nova` as its default preset, and the installed skill already carries Base-specific API guidance such as `render` instead of Radix's `asChild` (`.pi/skills/shadcn/rules/base-vs-radix.md`). Choosing Base UI therefore follows the current shadcn path without giving up an established local investment.

React Aria is also a first-class shadcn base, but shadcn still identifies Base UI as the default and Radix as fully supported. There is no project requirement that makes React Aria's distinct component APIs preferable here. [Official React Aria base announcement](https://ui.shadcn.com/docs/changelog/2026-07-react-aria)

## Vercel `react-best-practices`: reject as default guidance

### Verified facts

The skill identifies itself as a React **and Next.js performance optimization** guide containing 70 rules that should influence writing, reviewing, and automated refactoring. [Skill scope and intent](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md#L1-L17)

Its headline rules mix generic JavaScript, React, Next.js, server/RSC, and Vercel ecosystem choices. It calls `next/dynamic` the correct heavy-component solution and prescribes SWR for client request deduplication. [Rule index](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md#L42-L99) · [`next/dynamic` rule](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/bundle-dynamic-imports.md#L8-L35) · [SWR rule](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/rules/client-swr-dedup.md#L8-L56)

Those prescriptions do not fit a Vite SPA already standardized on Effect Atom. Several rules also introduce optional libraries or assert universal performance priorities without measurements from this application.

### Conclusion

Do not install it. It is potentially useful as an **on-demand performance-audit catalog**, but its broad trigger would continuously inject Next.js, RSC, SWR, and premature-optimization advice into ordinary component work. For normal React guidance, prefer official React docs and mechanically enforced lint/type rules. For performance work, profile first, then research and adopt only the relevant verified technique.

## Vercel `react-view-transitions`: good specialist guide, wrong dependency channel

### Verified facts

This specialist skill is actively maintained and has recent commits explicitly fact-checking it against React and Next source. [Skill history](https://github.com/vercel-labs/agent-skills/commits/main/skills/react-view-transitions/SKILL.md)

It also explicitly instructs non-Next applications to install `react@canary react-dom@canary`, and it mandates implementing every applicable animation pattern. [Skill availability](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-view-transitions/SKILL.md#L39-L48) · [implementation policy](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-view-transitions/SKILL.md#L14-L30)

That channel requirement is accurate: official React docs mark both `<ViewTransition>` and `addTransitionType` as Canary/Experimental APIs. [Official `<ViewTransition>` status](https://github.com/reactjs/react.dev/blob/main/src/content/reference/react/ViewTransition.md#L1-L14) · [official `addTransitionType` status](https://github.com/reactjs/react.dev/blob/main/src/content/reference/react/addTransitionType.md#L1-L12)

### Conclusion

Do not install it for this React 19.2.8 SPA. The skill's quality does not make its APIs available in the pinned stable build, and animation guidance should not pressure the project into a Canary dependency. Re-evaluate the skill only if view transitions become an approved feature and the required APIs enter the selected stable React version—or the project explicitly approves the Canary channel.

## Minimal agent setup

Keep the exact React and Effect source subtrees with concise source-cited notes. Keep the official shadcn skill, but add no shadcn subtree and no separate shadcn pattern note. Do not install either Vercel React skill.

When UI implementation begins, initialize `components.json` after choosing the primitive base, preset, icon library, and Tailwind setup. Thereafter the skill, CLI, generated component source, and current call sites provide the shadcn guidance and review workflow.
