# Publish a Price

The pricing object serves one shared catalog. Configure a dedicated Cloudflare Access application
for `api.fidyapp.com/internal/support/prices` with a human operator policy and sessions up to
15 minutes. Bind its audience to private Core as `PRICING_PUBLISH_AUDIENCE`. Keep this audience
distinct from identity recovery, billing refunds and erasure. An unconfigured installation refuses publication.

Submit a JSON file with `publicationId` (a fresh UUID) and `price` (the complete encoded
Subscription Price including a fresh Price ID, Money, billing period, service market, tax
treatment, renewal terms and payment methods). Submit through the Access-authenticated session:

```sh
cloudflared access curl https://api.fidyapp.com/internal/support/prices \
  --request POST --header 'Content-Type: application/json' --data-binary @publication.json
```

HTTP 200 returns the publication and Price IDs. After response loss, authenticate again as the
same operator and submit the same file. HTTP 409 means an identity already has different terms or
belongs to another publication. Verify the intended action before assigning any new identity.
An earlier exact billing registration retains its Price and original deadline. Communicate Price
changes manually outside Fidy.
