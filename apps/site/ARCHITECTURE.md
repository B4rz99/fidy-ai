# Public site architecture

`apps/site` owns Fidy's public marketing, legal content and discovery at `fidyapp.com`.
Read the repository [architecture](../../ARCHITECTURE.md) for system boundaries. Product interactions
belong to `apps/web`; authentication and financial authority remain with the server.

## Rendering and ownership

Astro produces static documents. Pages own URLs and content, layouts own shared document structure
and metadata, and components compose presentation. Selected demonstrations use React islands;
lightweight document scripts support navigation, theme and motion.

The site has no product session, authentication client or database binding. Product links enter the
web application. Legal disclosures must remain consistent with the accepted Consent evidence and
its recorded URLs.

## Discovery and serving

Public pages provide metadata, sitemap entries and agent discovery. HTML and Markdown representations
are generated at build time; a site-owned Worker selects the requested representation. Missing pages
retain real 404 responses.

Alchemy deploys the site as a separate Cloudflare Worker without API bindings. Build validation owns
static output and document security policy; infrastructure owns domain and edge configuration.
Deployment procedures belong in the [Production runbook](../../docs/operations/production-releases.md).
