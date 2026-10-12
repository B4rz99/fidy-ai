# Provider Authentication

Google and Microsoft sign-in use the React route and its mounted private controller. The generated authentication client owns transport; the controller owns pairing proof, provider popup and one-time recovery disclosure. Disposal clears private state and aborts pending work.

Coverage: `feature.test.tsx`, `controller.test.ts`, application authentication tests and built-browser provider/pairing journeys. The Foldkit implementation was replaced with the preceding React implementation on 2026-10-11.

Token identity confirmation uses the closed `resume=pat` route flag with existing-account login. Both provider choices preserve the continuation. Successful authentication returns to `/settings/access?resume=pat`; there is no caller-supplied redirect URL. The PAT owner verifies the current User before consuming the bounded draft and requires another explicit issuance confirmation. Native Google and Microsoft Core/D1 browser journeys exercise the complete handoff, issuance and revocation. Production provider completion is still pending.

Production release `804b122e7f68eec439f165b42cf99b6aedff99f1` deployed successfully on 2026-10-12. The freshness-only refusal opened the Google identity-confirmation page with `resume=pat`, same-account copy and no signup agreement. “Volver al token” restored the approved name, Lectura permission and seven-day review without issuance. Actual Google popup completion is unverified: native popup access was blocked by the locked Mac, and the User was asked to complete that step. Local native Google/Microsoft completion remains the integration evidence for the full provider round trip.
