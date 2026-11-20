# Bound browser retries to safe requests and proven non-admission

All derived browser clients use a validated exact origin, credentials, no-store requests, manual
redirects, and boundary-specific deadlines and response limits. Authentication and enrollment have
their own published codecs. An injected transport can replace Fetch without replacing these checks.
Diagnostics project safe metadata, including the separately validated trace receipt that the
upstream HTTP client's response serialization omits.

Retry GET and HEAD transport failures once. Canonical requests and safe web-auth reads can retry
a declared unadmitted resource refusal only after the complete refusal codec proves what happened.
Use a bounded Retry-After within the original deadline, including decoder load and queue time.
Canonical requests share two active transfers for each client, and retry pacing does not occupy a
transfer slot. Avoid replaying uncertain mutations or enrollment/authentication submissions.

Present refresh and refresh failure separately from the retained successful result. Declared
failures keep their typed meaning while defects and interruption use closed discriminators rather
than exposing Causes. A canonical 401 signals the bound browser lifetime once. The ordinary
binding read requests public session identity without adopting or renewing another cookie.
