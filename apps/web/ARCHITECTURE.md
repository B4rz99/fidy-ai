# Web architecture

`apps/web` is Fidy's React/Vite product application at `app.fidyapp.com`. It owns browser routing,
product presentation and interaction state. Read the repository [architecture](../../ARCHITECTURE.md)
for system boundaries; marketing and legal content belong to `apps/site`.

## Application shape

Application composition assembles routes, shared UI and independently owned features. Features own
behavior across their views and expose deliberate interfaces to other features. Presentation receives
display state and actions; interaction owners coordinate submission, uncertainty and recovery.

| Concern                                        | Owner                                                   |
| ---------------------------------------------- | ------------------------------------------------------- |
| Navigation and route state                     | TanStack Router                                         |
| Server resources and shared asynchronous state | Effect Atom                                             |
| Local drafts and component interactions        | React                                                   |
| Authentication lifetime and bound work         | Session owner and authentication-scoped registry        |
| HTTP policy                                    | Shared browser transport beneath server-derived clients |

Features load independently where useful. Code preparation and cached display data do not grant
access or trigger domain changes.

## Server boundary

The web consumes browser-safe server declarations and generated clients. Canonical operations,
financial calculations, authorization and persistence remain server-owned. Dedicated authentication,
payment, privacy and hosted-conversation clients use their server-declared contracts.

Shared transport owns request bounds, cancellation and safe failure handling. Feature owners retain
uncertain mutation outcomes and recover by observing canonical state; a lost response cannot prove
rollback or authorize blind replay. Diagnostics contain bounded metadata rather than User content.

## Authentication and state lifetime

Each authenticated lifetime binds clients, queries and pending work to one observed browser session.
Session replacement retires that work and prevents late results from entering a new lifetime.
The server checks live authority on protected requests; retained browser state is for presentation.

Authentication features present server-owned proof and approval flows. Sensitive proof and disclosure
state stays with its mounted owner. Privacy and account-security flows have independent access
boundaries so loss of ordinary product access does not block the applicable controls.

Payment credentials travel directly to the payment provider through a dedicated browser boundary.
The server owns enrollment and verified billing state. Hosted chat similarly presents server-owned
Turns and supplies visible-delivery evidence; the browser does not execute the agent's tools.

## Production artifact

Vite builds one assets-only application Worker for both protected and canonical installations. The actual browser hostname selects its exact API origin. Each host receives matching CSP and preconnect headers and uses its own host-only cookies. The static bundle contains public contract and release metadata. Synthetic transport signing and private provider credentials stay in the protected runner and Workers. Marketing and customer documentation have independent Workers.

## Further reading

Feature behavior belongs in the `FEATURE.md` files under [features](src/features/), including
[Transactions](src/features/transactions/FEATURE.md), [Dashboard](src/features/dashboard/FEATURE.md),
[authentication](src/features/provider-authentication/FEATURE.md), [privacy](src/features/privacy/FEATURE.md)
and [hosted chat](src/features/agent/FEATURE.md).
Shared conventions and validation expectations belong in [coding standards](../../CODING_STANDARDS.md)
and [security standards](../../SECURITY_STANDARDS.md).
