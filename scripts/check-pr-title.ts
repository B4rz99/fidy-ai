#!/usr/bin/env bun

import { loadCommitConvention } from "./check-commit-message";

const title = Bun.env.PR_TITLE;

if (title === undefined || title.trim().length === 0) {
  process.stderr.write("PR_TITLE env var is required\n");
  process.exit(1);
}

// The squashed trunk subject is the PR title, so it answers to the same
// allowlist the commit-msg hook enforces: README.md's commit convention.
const convention = await loadCommitConvention();
const errors = convention.validateHeader(title);

if (errors.length > 0) {
  process.stderr.write(`PR title: ${title}\n\n${convention.formatErrors(errors)}\n`);
  process.exit(1);
}
