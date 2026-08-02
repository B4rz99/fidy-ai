# Launch checklist

The following release gates are intentionally outside automated build verification and must remain unchecked until their named evidence exists.

## Legal and privacy

- [ ] A Colombian lawyer has reviewed and approved both `public/politica.html` and the exact disclosure in `src/shell/consent/current-disclosure.ts` for the revisions shipped at launch.
- [ ] The approved `public/politica.html` is deployed by the public web host at `https://fidyapp.com/politica`, and its deployed SHA-256 digest matches the `PolicySnapshot` digest in `current-disclosure.ts`.

The API process does not establish the canonical policy host. Its `/politica` route is a local and preview delivery adapter for the same source-controlled file; production DNS and routing must serve that file from `PUBLIC_WEB_ORIGIN` before launch.
