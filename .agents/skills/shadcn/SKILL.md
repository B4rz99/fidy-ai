---
name: shadcn
description: "Add, update, or compose shadcn/ui components, or configure shadcn registries and presets."
user-invocable: false
allowed-tools: Bash(npx shadcn@latest *), Bash(pnpm dlx shadcn@latest *), Bash(bunx --bun shadcn@latest *)
---

# shadcn/ui

Use the project's existing components and design tokens. Inspect `components.json` and the components being changed; use `shadcn info --json` when resolved paths, base, preset, or icon-library details are needed. Run the CLI with the project's package runner (`npx shadcn@latest`, `pnpm dlx shadcn@latest`, or `bunx --bun shadcn@latest`).

Prefer installed components and built-in variants. Preserve aliases, primitive library, icon library, and local customization. Check component APIs against their installed source; use `shadcn docs <component>` and fetch the returned documentation when adding a component or resolving uncertain usage.

## Read for the change

- For component selection, composition examples, and project metadata fields, read [COMPONENTS.md](COMPONENTS.md).
- Before installing or updating components or switching presets, read [UPDATING.md](UPDATING.md). Preview affected files and preserve local edits; use overwrite only within explicit user authorization.
- For styling, forms, overlays, icons, or chat, read the matching rules below. Apply the rules relevant to the components being changed.
- For CLI flags, registry authoring, or theme customization, use the corresponding reference below.

Preset codes belong to the CLI: use `preset decode`, `preset resolve`, or `apply` rather than decoding them manually. After registry additions, inspect the generated files for incorrect aliases, icon imports, missing subcomponents, and accessibility issues before declaring the change complete.

## Detailed References

- [rules/forms.md](./rules/forms.md) — FieldGroup, Field, InputGroup, ToggleGroup, FieldSet, validation states
- [rules/composition.md](./rules/composition.md) — Groups, overlays, Card, Tabs, Avatar, Alert, Empty, Toast, Separator, Skeleton, Badge, Button loading
- [rules/chat.md](./rules/chat.md) — MessageScroller, Message, Bubble, Attachment, Marker; streaming, anchoring, jump-to-latest
- [rules/icons.md](./rules/icons.md) — data-icon, icon sizing, passing icons as objects
- [rules/styling.md](./rules/styling.md) — Semantic colors, variants, className, spacing, size, truncate, dark mode, cn(), z-index
- [rules/base-vs-radix.md](./rules/base-vs-radix.md) — asChild vs render, Select, ToggleGroup, Slider, Accordion
- [cli.md](./cli.md) — Commands, flags, presets, templates
- [registry.md](./registry.md) — Authoring source registries, `include`, item definitions, dependencies, GitHub registry rules
- [customization.md](./customization.md) — Theming, CSS variables, extending components
