# Security findings ledger

One line per resolved pentest finding. Full evidence rides the fix pull request.

| ID    | Severity | Violated section               | Fix                                                                                  |
| ----- | -------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| F-006 | Medium   | `SECURITY_STANDARDS.md` §5, §3 | #2384 — exempt support-confirmed no-charge attempts from erasure sealing             |
| F-003 | Medium   | `SECURITY_STANDARDS.md` §10    | #2389 — terminal revocation budget on wrong-proof PAT-pairing claims                 |
| F-001 | Low      | `SECURITY_STANDARDS.md` §10    | #2398 — per-source cap on concurrent OAuth leases                                    |
| F-004 | Low      | `SECURITY_STANDARDS.md` §10    | #2394 — cached operator signing keys and the completed operator rate-limit allowlist |
| F-005 | Low      | `SECURITY_STANDARDS.md` §9     | #2401 — refund support paths refuse any browser Origin header                        |
| F-002 | Low      | `SECURITY_STANDARDS.md` §1     | #2403 — refusals advertise only recovery operations the live credential can invoke   |
