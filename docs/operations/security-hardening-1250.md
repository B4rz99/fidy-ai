# Web and API security findings (#1250)

The review of 8d57b9f identified omitted provider edge-rate coverage, missing HSTS, mutable
scanner images and the accepted braces advisory. Provider accounting and limits are recorded in
[admission coverage](admission-coverage.md).

## HTTPS persistence

Alchemy manages Cloudflare's `security_header` zone setting with a one-year HSTS max-age.
The API response policy and the web static `_headers` carry the same value. The zone setting
covers the apex redirect too. Production verification checks the effective apex, app metadata
and API health headers; the edge smoke gate also checks rejected API responses.

`includeSubDomains` and preload remain disabled. Enabling either needs an inventory proving HTTPS
readiness of all affected subdomains and a separate reviewed change. HSTS already cached by a
browser persists after a code rollback: keep HTTPS available throughout the advertised lifetime.
To withdraw it, serve max-age=0 while HTTPS remains working. See
[Cloudflare's HSTS requirements](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/).

## Scanner updates

CI references the Docker Hub Fluid Attacks `ss`, `sast` and `sca` OCI index digests resolved for
this PR; image pulling checks immutable content rather than following a mutable tag. No automatic
merge or mutable-tag execution is permitted. To update, resolve the publisher's intended tag
through the registry, inspect its index/platform manifests and upstream release changes, replace
the digest in `.github/workflows/ci.yml` in a dependency-review PR, and run all three strict
scanner jobs before merging. Retain the digest in the diff as the reviewable executable identity.
The existing npm minimumReleaseAge policy is unchanged.

## Unresolved accepted dependency risk

Rechecked October 12, 2026: the
[GitHub advisory GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
still lists braces <=3.0.3 with no patched version; npm's latest release is 3.0.3. The required
shadcn development CLI still pulls this dependency. The existing exception expires exclusively
at 2026-10-17T00:00:00Z. This PR neither extends that exception nor removes its matching SCA
exclusion, and does not claim to fix the vulnerability. Continue to use only reviewed component
names, local paths and trusted registries. Resolve the chain once a fixed release meets the
seven-day cooldown, or explicitly reassess before expiry; do not bypass that cooldown.
