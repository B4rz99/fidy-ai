# Keep institution Connection authority in the browser handoff

A Connection is the stable association of one User and Institution. It survives reauthorization
and stays independent of provider integration identity. Discovery includes unavailable
Institutions and exposes only the caller's own safe association. The canonical connect operation
can create or reuse an attempt, or report an already authorized Connection.

A continuation is a public browser locator. Institution authority still requires authentication
of the same User and successful authorization. Provider identifiers, credentials and attempt
authority stay behind the browser flow.

Ingress recognizes the declared browser continuation path independently from the HTTP method.
This gives method failures to the owning route, which applies the exact origin and header
policy and rechecks live WebSession and Consent in the authorized work.

Bancolombia application credentials are private Core authority. Keep the certificate binding and
registered signing key separate. The bounded support Sandbox flow can request an application
token and push the exact already-created consent request once. Application token verification
cannot authorize the customer's account, and token revocation does not cancel bank consent.
Cleanup stays available after the admission window closes.

Authorization preparation claims one original User-owned attempt before bank egress. Never
retry uncertain submission. Browser admission, review and its Audit use the same live
authority. Account discovery commits exact read-only page work before scheduling it. A
recurring schedule is a prompt to recheck authority, and a Queue message alone cannot admit work.
Held bank-authority cleanup remains independent of browser login, Consent and the test window.
Connection-derived data still needs its own completed suppression before whole-User erasure.
