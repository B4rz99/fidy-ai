# Fidy

Fidy is an agent-first personal finance product being built for Colombia. It brings financial
records, budgets, and insights into one system that people can use through conversation, a web
application, or their own agents.

**Fidy is in development and has not launched.** Implemented components are not a promise that a
channel, integration, or workflow is available to real users.

## One financial model, multiple interfaces

WhatsApp is the conversational channel: users describe financial activity and interact with Fidy's
hosted agent. The React web application provides structured views and controls for financial data,
dashboards, account security, and subscriptions. A canonical API gives user-owned agents access to
the same operations, with explicit permissions rather than unrestricted database access.

These interfaces share one domain model. A transaction captured through conversation is not a
separate record system from one viewed on the web. The hosted agent invokes the same canonical
operations as other authorized clients; generated text never grants permission or becomes an
independent source of financial truth.

## Financial records with context

The implemented foundation includes transaction capture and correction, source evidence,
categorization and user-defined keyword rules, budgets, dashboard documents and views, statement
processing and review, recurring-charge detection, and user-owned Memory for relevant context.

Money uses exact decimal values with explicit Currency. Different currencies remain separate rather
than being silently converted or summed together. Corrections and reconciliation preserve source
evidence, and uncertain imported material can require review instead of becoming an unquestioned
financial fact.

Some product paths remain deliberately unavailable. Forwarded institutional email requires verified
sender and connection admission before inbound routing can be enabled. Receipt/image processing is
not yet an executable capture path, and hosted MCP/OAuth access remains a design rather than a live
integration.

## Technical foundation

Fidy is a TypeScript monorepo built around Effect and Schema. Domain decisions are separated from
provider and platform adapters. Canonical operation declarations supply typed clients, OpenAPI,
access policy, and hosted-agent tool descriptions, keeping interfaces aligned without parallel
hand-maintained contracts.

The web application uses React, Vite, and Effect Atom. The Bun CLI provides a user-owned-agent
credential entrypoint through browser-approved pairing and native OS credential storage; it is not
a separate authorization authority.

Cloudflare provides the production execution model:

- **Workers** separate public ingress from the private application boundary.
- **D1** retains authoritative application state; **Durable Objects** coordinate per-user work.
- **Queues and Workflows** handle redelivery and durable multi-step execution.
- **R2** retains bounded private source material.
- **Workers AI** supplies Fidy-controlled hosted inference.

Alchemy declares the deployment topology. Specialist adapters connect WhatsApp through Kapso/Meta,
payments through Wompi, and outbound email through Resend.

## Trust boundaries

Authorization is enforced by the server for each protected action. Browser sessions, personal access
tokens, consent, and sensitive-operation confirmation have distinct responsibilities. An agent's
request or a queued identifier cannot bypass those checks.

Financial changes and their required accountability evidence commit together. External delivery and
provider calls are treated separately: retries must account for uncertain outcomes rather than
assuming that a timeout means nothing happened. Hosted replies become completed Transcript evidence
only after authenticated delivery evidence, not merely after generation.

Telemetry is limited to approved operational metadata. Credentials, financial content, prompts,
replies, and raw provider payloads are not diagnostic data. Missing authority or an unavailable
adapter produces a closed failure rather than a local-state or alternate-provider fallback.
