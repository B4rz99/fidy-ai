# Test seams and the core mutation gate

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

A test that mocks a repository or handler can verify a local interaction while missing an
integration error in the API path. Conversely, sending every pure decision through HTTP and a real
database makes the important domain boundaries slow and obscures failures.

The core contains branch-heavy business decisions whose correctness is stronger than a line
coverage claim. The shell contains integration and transport code that includes documentation and
one-shot migration paths not all reachable through a behavioural test.

## Decision

Use two primary application seams and one further agent seam:

- **Core seam:** call exported pure decisions directly, with no server or database.
- **API seam:** traverse operation decoding, authorization, handlers, repositories, and real
  PostgreSQL to verify integration, persistence, responses, suggested operations, and isolation.
- **Agent seam:** call `AgentService.handleTurn` through the CLI harness with external language
  model and terminal adapters substituted, while canonical handlers, authorization, repositories,
  PostgreSQL, and the generated client remain real.

Core tests do not mock shell collaborators or test shell orchestration in isolation. A policy with
a stable pure interface may be tested directly, but its integration remains covered at the API
seam. Caller-resolution boundaries may be tested through their concrete persistence adapters when
they protect data that must not appear in a canonical response.

The core mutation gate requires every in-scope behavioural mutant to be killed. The exact mutation
scope, runner, exclusions, and coverage configuration live in `stryker.config.mjs` and the Vitest
configs; the shell retains its own coverage and CRAP gates.

Isolation, suggested-operation validation, and attributable-call auditing derive their operation
set from the assembled API and use exhaustive typed probes where each operation needs explicit
behaviour.

## Consequences

Core feedback is fast and tests the decision independently of infrastructure. API tests are more
expensive but prove that the operation is wired correctly, and the agent seam proves the hosted
loop without replacing the product's canonical path.

The mutation gate is intentionally scoped to core and can run outside pull-request feedback. Shell
mutation testing is not a 100% gate because some documentation, response-encoding, and one-shot
migration mutants are not reachable through a meaningful seam.

## Rejected alternatives

### Test core only through the API seam

Rejected because exact value validation and decision boundaries would require a full HTTP and
PostgreSQL round trip for every pure branch.

### Mock repositories in core or handler unit tests

Rejected because mocks test an invented interaction rather than the real persistence and operation
path. The API seam is the integration test for orchestration.

### Gate core and shell mutation at the same threshold

Rejected because the shell includes behaviour that cannot be observed or repeated from a meaningful
application seam. A lower threshold would make the score a quota of unnoticed defects.
