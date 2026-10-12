# Provider Authentication

Google and Microsoft sign-in use the React route and its mounted private controller. The generated authentication client owns transport; the controller owns pairing proof, provider popup and one-time recovery disclosure. Disposal clears private state and aborts pending work.

Coverage: `feature.test.tsx`, `controller.test.ts`, application authentication tests and built-browser provider/pairing journeys. The Foldkit implementation was replaced with the preceding React implementation on 2026-10-11.
