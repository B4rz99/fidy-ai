# Export only closed operational telemetry

The indexed vocabulary and runtime validator come from one registry. Span descriptors choose
closed operational fields per Work kind, and receipts expose only correlation coordinates.
Failure capture keeps an approved code and scrubbed application stack frames. Provider input,
exception text, baggage, User identity and source context stay outside export. A standalone
error may carry SDK trace coordinates without an operation. A transaction always has an
operation because it originates in a span.

Only exact trace coordinates and capture time cross trusted durable boundaries. Malformed,
future and expired continuation data starts a safe root. In-process children already have a
live parent and need no age check. The service owns terminal span completion and contains
adapter failures so diagnostics cannot change the wrapped operation's outcome. Final SDK
hooks rebuild and validate the approved event and span shapes before export.

Ingress strips client-supplied propagation before any trusted service-binding transfer.
Invalid transport correlation is discarded independently of the domain payload and cannot
reject its work. In-process refusal-burst observation is deliberately lossy on restart and
across distributed traffic. Each observer uses closed aggregate metadata and no stored
subject presence. A native Promise retains its original resolution or rejection.
