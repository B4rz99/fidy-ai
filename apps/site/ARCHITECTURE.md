# Public site architecture

`apps/site` owns Fidy's public marketing and legal website at `https://fidyapp.com`.
Read the root [architecture](../../ARCHITECTURE.md) for cross-application boundaries.
The React product, authentication, and account settings remain in `apps/web` at
`https://app.fidyapp.com`; the API remains at `https://api.fidyapp.com`.

## Rendering and ownership

Astro produces static HTML for the homepage, six feature pages, privacy policy,
cookie information, draft terms, and a real 404. `src/pages` owns URLs;
`src/layouts/site-layout.astro` owns document metadata, canonical URLs and page shape;
`src/components` owns static page composition; `src/islands` contains the preserved
React demonstrations and their supporting presentation. React components without
client directives render only during the build. Interactive demonstrations hydrate
on visibility; the hero PhoneDemo hydrates on load. Theme, navigation and entrance
motion use the small document script in `src/scripts/site.ts`.

There is no server adapter, authentication client, session state, database binding,
or import from another application's implementation. Product links are ordinary
absolute links to `app.fidyapp.com`. Public installer URLs redirect to the existing
app-owned installer artifacts. The privacy source in `src/assets/policy.html` is
byte-identical to the accepted Consent disclosure and is checked by the existing
policy-integrity and server disclosure tests. Recorded disclosure URLs remain
unchanged; app-host legal routes redirect to the site.

## Discovery

Every public document includes its own title, description, canonical URL and
Open Graph metadata in its initial HTML. The homepage's SoftwareApplication and
FAQPage microdata describe the visible content, and all feature pages have static
internal links. Sitemap generation excludes draft terms and the 404; their HTML
contains `noindex`. Robots points to the generated sitemap index. `llms.txt` gives
agents public setup guidance and links to the correct site, app and API origins.
These are crawlability and answer-extraction improvements, not guarantees of
search ranking or AI citations.

## Deployment and verification

Alchemy owns a separate assets-only `Site` Worker with a custom domain at the apex,
no API bindings and no production `workers.dev` URL. Asset serving drops trailing
slashes and returns the built 404 document for missing paths instead of an SPA
fallback. `_headers` applies security headers and immutable caching to hashed
`_astro` assets. Astro emits a document CSP with hashes for its hydration bootstrap;
static chart geometry lives in external CSS instead of inline style attributes.

`bun run dev:site` starts the site on port 4321. Its `--ignore-lock` flag keeps Astro in the
foreground under agent execution so Alchemy owns the process lifetime. `build` generates the static pages and rejects unexpected output files.
The root type check checks Astro and React types once. The checker is installed with a
frozen lock in `tools/astro`, because its Volar dependency needs TypeScript 6's
JavaScript compiler API while the workspace uses TypeScript 7. `build:production`
also requires and publishes the exact `RELEASE_GIT_SHA`. The normal Production
workflow builds and verifies both static artifacts and checks their revision on
their public hosts. Core/ingress candidate promotion remains server-owned.

Playwright uses Astro’s standard preview command for built HTML on port 4322, with JavaScript-disabled content
checks, canonical metadata, sitemap exclusions, interactive island hydration,
theme persistence, browser/CSP errors and serious accessibility violations. The
repository verification groups include the site build, types and browser suite.

The existing Builds runner owns the public-site browser suite and reuses the static artifact
it built earlier in that same job. `SITE_BROWSER_PREBUILT=true` checks the artifact before
starting preview. Standalone browser runs still build fresh output. Product browser shards do
not repeat these independent public-site cases.
