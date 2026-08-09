// The set of behavioural source files the quality gates measure, shared by the
// total-coverage threshold (vitest.config.ts), the core-only run
// (vitest.core.config.ts), the CRAP coverage run (vitest.crap.config.ts), and
// the CRAP analyzer (tools/crap/run.mjs) so they never drift.
//
// The scope is split along the tree boundary (ARCHITECTURE.md §1) so the
// core-only run measures core alone while the full run measures both. Note
// src/main.ts now falls outside by construction rather than by an exclusion:
// it is neither tree, it is the runtime bootstrap.
//
// Excluded on purpose: test files, the test-only API harness under src/shell/testing, and the
// preload side-effect module. The preload is process wiring like src/main.ts; its decoded
// configuration and single-assignment handoff remain measured through their behavioural modules.
//
// Plain .mjs (not .ts): tools/crap/run.mjs feeds these to crap4ts, which parses
// through the classic TypeScript compiler API that this repo's Effect tsgo
// `typescript` build does not expose, so a .ts module here would fail to load.

export const CORE_SRC = ["src/core"];

export const SHELL_SRC = ["src/shell"];

export const SOURCE_SRC = [...CORE_SRC, ...SHELL_SRC];

export const CORE_EXCLUDE = ["**/*.test.ts"];

export const SOURCE_EXCLUDE = [
  ...CORE_EXCLUDE,
  "src/shell/testing/**",
  "src/shell/observability/preload.ts",
];
