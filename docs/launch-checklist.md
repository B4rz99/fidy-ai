# Launch checklist

The following release gates are intentionally outside automated build verification and must remain
unchecked until their named evidence exists.

## Legal and privacy

- [ ] A Colombian lawyer has reviewed and approved both the web application's source-controlled policy
      and the Core Worker's exact disclosure for the revisions shipped at launch.
- [ ] The approved policy is deployed by the public web Worker at `https://fidyapp.com/politica`, and
      its deployed SHA-256 digest matches the Core Worker's `PolicySnapshot` digest.

The web application is the sole policy delivery adapter. The API ingress deliberately returns `404`
for `/politica`; production DNS must route `PUBLIC_WEB_ORIGIN` to the Cloudflare-hosted web application
before launch.
