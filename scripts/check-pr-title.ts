#!/usr/bin/env bun

import { formatCommitMessageErrors, validateCommitHeader } from "./check-commit-message";

const title = Bun.env.PR_TITLE;

if (title === undefined || title.trim().length === 0) {
  console.error("PR_TITLE env var is required");
  process.exit(1);
}

const errors = validateCommitHeader(title);

if (errors.length > 0) {
  console.error(`PR title: ${title}\n\n${formatCommitMessageErrors(errors)}`);
  process.exit(1);
}
