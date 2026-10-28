# Astro static documents and React islands

Use Astro for public documents that should be complete before JavaScript runs.
Fidy pins `astro@7.4.1`, `@astrojs/react@7.1.0` and `@astrojs/sitemap@3.7.4` in
[the site manifest](../apps/site/package.json). The integrity-locked installed
packages are the selected implementation source.

## Source-backed shape

- [Astro project structure](https://docs.astro.build/en/basics/project-structure/):
  `src/pages` defines routes; `public` copies unchanged assets to the output.
- [Client directives](https://docs.astro.build/en/reference/directives-reference/#client-directives):
  React components render HTML at build time. `client:visible` delays hydration,
  `client:load` hydrates on load, and omitting a client directive sends no component
  JavaScript. Verify in `node_modules/astro/dist/runtime/server/render/component.js`
  and `node_modules/astro/dist/runtime/server/hydration.js`.
- [Configuration](https://docs.astro.build/en/reference/configuration-reference/):
  `output: "static"`, `site`, `trailingSlash: "never"`, `build.format: "file"` and
  `build.inlineStylesheets: "never"` produce portable pages and external CSS.
  Build-time `Astro.url.pathname` can include `.html`; normalize it when generating
  public canonical URLs. The sitemap integration uses the public route URLs.
- [Content Security Policy](https://docs.astro.build/en/guides/content-security-policy/):
  `security.csp` emits a meta policy and hashes Astro's inline script bootstrap.
  External styles do not authorize inline style attributes; use CSS classes for
  static chart geometry. Header-only protections such as frame denial belong in
  the asset `_headers` policy. Verify generated HTML and browser CSP errors.

## Fidy owner and test seam

[SiteLayout](../apps/site/src/layouts/site-layout.astro) owns shared metadata;
[the Astro config](../apps/site/astro.config.ts) owns integrations and CSP.
[The browser suite](../apps/site/e2e/site.spec.ts) checks built output with and
without JavaScript, interactive hydration, real missing-page status and discovery.
There is no client-side router or cross-application implementation import.
The [isolated checker](../tools/astro/check.ts) uses the public `AstroCheck` API in
`@astrojs/language-server/dist/check.js`; both it and Volar resolve TypeScript 6
from the tool install. Do not hoist that graph into the TypeScript 7 workspace.
