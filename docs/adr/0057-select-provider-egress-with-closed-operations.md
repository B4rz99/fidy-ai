# Select provider egress with closed operations

Outbound HTTP selects destination, credentials, stream budget, retained headers and trace policy
from the operation's closed tag. This keeps caller-supplied coordinates and credential authority
out of request data. Wompi signing belongs inside that authority boundary. Other adapters own
their body encodings. Provider failures return safe facts without destination or response body,
and transport terminates an overflowing response through its owned scope.

Ordinary provider transport refuses redirects. Anonymous CLI release metadata admits only two
reviewed HTTPS redirects. OIDC protocol credentials stay in POST bodies, Access key selection is
bound to configured team identity, and synthetic bank proof requests require the reviewed
Sandbox policy. Production cannot use that policy.
