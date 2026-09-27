---
name: cloudflare
description: "Build or configure Cloudflare services. Consult product references and current official documentation for the services involved."
references:
  - workers
  - pages
  - d1
  - durable-objects
  - workers-ai
---

# Cloudflare Platform Skill

Consolidated skill for building on the Cloudflare platform. Use decision trees below to find the right product, then load detailed references.

Your knowledge of Cloudflare APIs, types, limits, and pricing may be outdated. **Prefer retrieval over pre-training** — the references in this skill are starting points, not source of truth.

## Retrieval Sources

Fetch the **latest** information before citing specific numbers, API signatures, or configuration options. Do not rely on baked-in knowledge or these reference files alone.

| Source                 | How to retrieve                                                       | Use for                                                   |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| Cloudflare docs        | `cloudflare-docs` search tool or `https://developers.cloudflare.com/` | Limits, pricing, API reference, compatibility dates/flags |
| Workers types          | `npm pack @cloudflare/workers-types` or check `node_modules`          | Type signatures, binding shapes, handler types            |
| Wrangler config schema | `node_modules/wrangler/config-schema.json`                            | Config fields, binding shapes, allowed values             |
| Product changelogs     | `https://developers.cloudflare.com/changelog/`                        | Recent changes to limits, features, deprecations          |

When a reference file and the docs disagree, **trust the docs**. This is especially important for: numeric limits, pricing tiers, type signatures, and configuration options.

## Select the relevant reference

For a named product, read only the relevant files under `references/<product>/`. If the product choice is unresolved or its folder is unclear, consult [PRODUCT-SELECTION.md](PRODUCT-SELECTION.md) for the decision trees and directory index.

Use the repository’s existing infrastructure tooling; consult the Wrangler skill only when writing Wrangler commands or configuration.
