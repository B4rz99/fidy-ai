# Keep institution Connection authority in the browser handoff

A Connection is the stable association of one User and Institution. It survives reauthorization
and stays independent of provider integration identity. Discovery includes unavailable
Institutions and exposes only the caller's own safe association. The canonical connect operation
can create or reuse an attempt, or report an already authorized Connection.

A continuation is a public browser locator. Institution authority still requires authentication
of the same User and successful authorization. Provider identifiers, credentials and attempt
authority stay behind the browser flow.
