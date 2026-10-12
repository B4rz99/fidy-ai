# Agent-safe design-system learnings for Fidy

_Research snapshot: 2026-08-27. Primary sources: Linear's StyleX migration report, Polar's Orbit design-system report, official StyleX, Tailwind CSS, and shadcn documentation, plus the current `@fidy/web` source._

## Executive recommendation

**Adopt the control model, not the StyleX migration.**

Fidy should keep Tailwind CSS 4 and its project-owned shadcn components for now. It should adopt four ideas from the articles:

1. make semantic design decisions the preferred styling vocabulary;
2. encode important restrictions in CI rather than agent instructions alone;
3. give shared components explicit styling contracts and deterministic precedence;
4. keep escape hatches narrow, named, and auditable.

Fidy should **not** currently migrate to StyleX, introduce a universal polymorphic `Box`, or ban semantic HTML elements. The relevant Linear performance win was removal of styled-components runtime rule generation; Fidy already uses Tailwind's build-generated CSS and has no runtime CSS-in-JS dependency (`apps/web/package.json:20-54`). A StyleX migration would therefore buy constraints and type safety, not remove the bottleneck Linear measured.

The first implementation should be a small design-system gate over feature code, followed by tightening the available Tailwind theme. This captures most of Polar's “correct by construction” benefit without replacing Fidy's existing shadcn foundation.

## What the articles actually establish

### Linear: explicit styling boundaries plus mechanical enforcement

Linear migrated from styled-components to StyleX because styled-components allowed components to be restyled from the outside, generated and injected CSS during render, and made precedence depend on open CSS composition. Linear chose StyleX for build-time atomic CSS, deterministic last-applied precedence, colocated styles, type-safe styling contracts, and resistance to styling at a distance. Its migration began with shared variables and primitives, proceeded from leaf components, allowed CSS Modules as an explicit fallback, and added lint and repository-wide checks for token use, styling-prop propagation, merge precedence, interaction consistency, and theme safety. Linear reports that removing runtime rule injection reduced styling-related main-thread work on selected view-heavy profiles, but explicitly says the end-to-end effect is hard to attribute. [Linear, “Styling Linear for the future”](https://linear.app/now/styling-linear-for-the-future-stylex)

StyleX's official contract supports those architectural claims: it generates static atomic CSS at compile time, avoids runtime style injection, uses deterministic last-applied merging, supports typed style props, and defines typed CSS variables with `defineVars`. [StyleX overview](https://stylexjs.com/docs/learn/) · [using styles and style props](https://stylexjs.com/docs/learn/styling-ui/using-styles/) · [defining variables](https://stylexjs.com/docs/learn/theming/defining-variables/)

**Conclusion for Fidy:** Linear's strongest transferable lesson is not “use StyleX.” It is “make styling boundaries explicit, then grade them mechanically.” Its performance result is not transferable evidence against Tailwind because Fidy does not generate CSS in React's render path.

### Polar: constrain the vocabulary available to agents

Polar's Orbit experiment argues that agent-written utility strings drift because many valid values remain available and because documentation is probabilistic. Orbit therefore exposes design tokens as typed props, encodes light and dark values behind each color decision, bans raw layout elements in favor of a polymorphic `Box`, and enforces the restrictions with ESLint. Polar is explicit that this is early, its token sets are still incomplete, and it migrates legacy Tailwind incrementally rather than through a rewrite. [Polar, “Orbit: an LLM-safe design system”](https://polar.sh/blog/orbit-llm-safe-design-system)

Two parts should be separated:

- **Strong principle:** a deterministic CI contract is more reliable than asking every fresh agent context to remember prose.
- **Local design choice, not a general result:** one universal `Box` and a ban on raw `<div>`, `<nav>`, `<ul>`, and related elements. Polymorphism preserves emitted semantics, but it also creates a broad primitive API and is not necessary to close Fidy's styling vocabulary.

Polar also calls tokens such as `background-card` decisions rather than values. That is true for role tokens such as `card`, `muted`, and `destructive`. Its spacing examples (`m`, `l`, `xl`) are still scale positions rather than usage-specific semantic decisions. Fidy should not manufacture names that imply more intent than they carry.

## Fidy's current position

Fidy already has a useful foundation:

- `@fidy/web` is a React/Vite application using Tailwind CSS 4.3.3 and project-owned shadcn Base UI components; it has no StyleX or runtime CSS-in-JS dependency (`apps/web/package.json:20-54`).
- `components.json` selects `base-nova`, CSS-variable theming, and local component ownership under `@/ui/components` (`apps/web/components.json:2-24`). The integrity script ensures shadcn output remains in that application-owned location (`apps/web/scripts/check-shadcn-integrity.ts:24-55`).
- The theme already exposes semantic color roles such as `background`, `card`, `primary`, `muted`, `destructive`, `border`, `input`, and `ring`, with light and dark values behind the same utility names (`apps/web/src/index.css:8-48`, `apps/web/src/index.css:50-125`). This is exactly the shadcn theming model: semantic CSS variables map to utilities, while dark mode overrides the token rather than requiring each call site to choose another color. [shadcn theming](https://ui.shadcn.com/docs/theming)
- Feature code generally composes project-owned `Alert`, `Badge`, `Button`, `Card`, `Empty`, `Progress`, `Skeleton`, and `Table` primitives instead of recreating them (`apps/web/src/features/dashboard/view.tsx:7-21`; `apps/web/src/features/pats/view.tsx:28-34`).
- The repository already treats enforced policy as the real standard: one Oxlint config runs in verification and supports a local JavaScript plugin (`.oxlintrc.json:1-9`). That is a ready-made mechanism for agent-safe design checks.

The remaining opening is that Tailwind's full default vocabulary is still imported and feature `className` strings are not constrained. Tailwind documents that importing its default theme exposes general-purpose color, spacing, radius, shadow, and typography utilities; it also supports resetting a whole namespace with, for example, `--color-*: initial`. [Tailwind theme variables](https://tailwindcss.com/docs/theme) Tailwind scans source as plain text rather than parsing typed component intent, and arbitrary values are deliberately supported. [Tailwind class detection](https://tailwindcss.com/docs/detecting-classes-in-source-files)

Concrete examples show why a gate would add value:

- feature code still uses `space-y-*`, despite the adopted shadcn guidance preferring explicit flex and gap (`apps/web/src/features/email-onboarding/feature.tsx:25-37`; `apps/web/src/features/browser-login/feature.tsx:52-91`);
- feature code contains arbitrary layout values such as `sm:grid-cols-[10rem_1fr]` and `min-h-[36rem]` (`apps/web/src/features/pats/view.tsx:243`; `apps/web/src/features/dashboard/view.tsx:366`);
- the dashboard has legitimate dynamic-layout escape hatches: a closed mapping for responsive split classes and an inline style for weighted children (`apps/web/src/features/dashboard/view.tsx:343-350`). A sound policy must preserve such bounded, named cases instead of banning syntax indiscriminately;
- generated/project-owned primitives themselves use advanced selectors, arbitrary values, and a few explicit dark-state refinements (`apps/web/src/ui/components/button.tsx:7-32`; `apps/web/src/ui/components/checkbox.tsx:7-18`). Feature policy therefore should not be naively imposed on the primitive implementation directory.

## What to adopt

### 1. A feature-code styling gate in CI

Add an Oxlint JavaScript rule or a focused AST repository check for `apps/web/src/features/**`. Start with rules that have low ambiguity:

- reject default palette utilities such as `bg-blue-500`, `text-zinc-600`, and `border-gray-200`;
- reject arbitrary color values and raw color-bearing inline styles;
- reject feature-level `dark:` color overrides; theme tokens own light/dark behavior;
- reject `space-x-*` and `space-y-*`; use layout with `gap-*`;
- reject dynamic construction of Tailwind class fragments; require a closed map of complete class strings;
- require narrowly scoped, reason-bearing suppression for genuine exceptions and add a check that reports suppression growth.

Keep `apps/web/src/ui/components/**` under a separate primitive policy. Those files are project-owned and reviewed, but shadcn/Base UI implementation details require selectors and state refinements that ordinary features should not copy.

This is directly aligned with both articles and with Fidy's existing “one config, always run” lint architecture. It also fixes actual local drift rather than introducing a speculative framework migration.

### 2. Close Tailwind's visual namespaces, but retain layout utilities

After the lint rule proves the migration surface, reset broad visual namespaces in `@theme` and expose only approved project tokens. Tailwind officially supports setting a namespace such as `--color-*` to `initial`, then defining only the desired names. [Tailwind theme variables](https://tailwindcss.com/docs/theme#overriding-the-default-theme)

Recommended boundary:

- **Close now:** colors; later evaluate shadows, radii, typography, and animation after inventorying what shadcn primitives require.
- **Keep open initially:** display, flex/grid, positioning, responsive variants, and the ordinary spacing scale. These express layout mechanics and are where Tailwind remains most useful.
- **Do not claim build failure is enough:** an unknown class may simply produce no CSS because Tailwind scans text and emits recognized utilities. The AST lint rule must provide the actionable CI failure.

This creates Polar's short menu for visual decisions while avoiding a large typed `Box` API.

### 3. Make component styling contracts explicit

Adopt Linear's rule that a component should not be reopened visually from the outside.

For Fidy's project-owned UI components:

- visual differences belong in typed variants (`variant`, `size`, or a more specific prop);
- `className` remains available for caller-owned layout only—width, placement, responsive container behavior—not colors, typography, borders, shadows, interaction states, or internal descendant selectors;
- local component styles precede caller layout classes through the existing `cn(...)` call, and conflicts that callers are not allowed to create are rejected by lint rather than resolved by convention;
- wrappers must deliberately forward the styling contract or deliberately close it; they must not silently advertise and drop `className`.

Do not add a universal `sx` prop merely to copy Linear. In StyleX, `sx` carries typed style objects with deterministic property merging. In Fidy's Tailwind/shadcn system, a broad string prop would not provide the same guarantee.

### 4. Treat escape hatches as design-system feedback

Allow a small number of named escape categories:

- dynamic geometry derived from application state, such as dashboard split weights;
- chart-library CSS custom properties;
- scoped CSS for third-party or policy-document markup that cannot be represented through component variants.

Require each exception to live behind a named helper or scoped class and a narrow suppression with a reason. Track the suppression count in CI. A growing count means the design system is missing a token, variant, or layout primitive; it should not silently normalize bypasses. This follows both Linear's explicit CSS Modules fallback and Polar's suppression-audit practice.

### 5. Migrate only as touched, with one cleanup pass for current violations

There is no legacy CSS-in-JS migration to manage. Fix the known `space-y-*` call sites and any palette/arbitrary-color findings when introducing the gate, then apply stricter contracts to feature files as they change. Linear's leaf-first strategy remains useful if shared primitives need tightening: establish tokens and contracts first, then update leaf feature components before highly shared wrappers. [Linear article](https://linear.app/now/styling-linear-for-the-future-stylex)

## What not to adopt now

### Do not migrate to StyleX

StyleX is technically credible and would provide typed styles, deterministic property merging, and compile-time extraction. Those are real benefits. But Fidy would pay for a second compiler integration, replacement of Tailwind/shadcn authoring conventions, rewriting locally owned primitives, and new interop decisions for shadcn updates and chart styling. The main measured benefit in Linear's report—removing styled-components runtime injection—does not exist here.

Re-evaluate StyleX only if at least one of these becomes true:

- profiling identifies styling work in Fidy's render or navigation path;
- Tailwind string checks become materially complex despite a closed visual vocabulary;
- cross-file component customization and precedence cause repeated regressions;
- Fidy starts publishing a reusable component package whose consumers need typed style composition.

### Do not introduce a universal `Box` or ban semantic elements

Fidy should keep direct semantic HTML (`main`, `nav`, `section`, `form`, `fieldset`, `dl`, and tables) and use small layout components only when a repeated abstraction earns a name such as `PageShell` or `Stack`. A universal `Box` would combine element polymorphism, DOM prop forwarding, responsive layout, and every token family into one broad interface. That is a shallow, high-surface module and conflicts with Fidy's preference for precise boundaries.

A lint rule can close visual vocabulary without banning the platform's semantic vocabulary. Raw `<div>` is not itself the failure; unconstrained visual decisions are.

### Do not create tokens for every repeated number

Promote a value only when it represents a stable shared decision. Keep semantic roles such as `card`, `muted`, `destructive`, and future finance-specific presentation roles when the product actually defines them. Keep ordinary scale tokens for spacing and sizing, and do not rename `16px` to something that falsely implies usage intent.

### Do not copy Linear's migration telemetry

A legacy-component counter and migration graph were useful for Linear's thousand-PR transition. Fidy has no parallel styled-components estate. The relevant metric here is much smaller: CI violations and justified suppressions. Add richer migration telemetry only if a real migration exists.

## Proposed implementation order

1. **Inventory and policy:** define the approved feature styling vocabulary and the exact exception categories in a short web design-system document.
2. **Mechanical gate:** add tested Oxlint/repository rules for palette colors, arbitrary colors, visual `dark:` overrides, `space-*`, and dynamic class construction; exempt primitive internals deliberately.
3. **Current cleanup:** fix existing feature violations and name the dashboard/chart exceptions.
4. **Theme closure:** reset Tailwind's default color namespace and re-expose only Fidy/shadcn semantic roles needed by the build.
5. **Component contracts:** enforce “`className` for layout; variants for appearance” at project-owned primitive call sites and add variants when real use cases require them.
6. **Measure before migration:** record bundle/runtime baselines; reconsider StyleX only against the explicit triggers above.

## Decision in one sentence

Fidy should become **agent-safe by enforcement while staying Tailwind/shadcn**: close the visual vocabulary, encode the boundary in CI, tighten component contracts, and leave StyleX and a universal `Box` for a future problem that actually requires them.
