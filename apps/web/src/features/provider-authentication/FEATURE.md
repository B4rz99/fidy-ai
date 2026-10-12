# Provider Authentication

Google and Microsoft sign-in use the React route and its mounted private controller. The generated authentication client owns transport; the controller owns pairing proof, provider popup and one-time recovery disclosure. Disposal clears private state and aborts pending work.

Coverage: `feature.test.tsx`, `controller.test.ts`, application authentication tests and built-browser provider/pairing journeys. The Foldkit implementation was replaced with the preceding React implementation on 2026-10-11.

Token identity confirmation uses the closed `resume=pat` route flag with existing-account login. Both provider choices preserve the continuation. Successful authentication returns to `/settings/access?resume=pat`; there is no caller-supplied redirect URL. The PAT owner verifies the current User before consuming the bounded draft and requires another explicit issuance confirmation. Native Google and Microsoft Core/D1 browser journeys exercise the complete handoff, issuance and revocation. Production provider completion is still pending.
