#!/usr/bin/env bun

const TYPES: readonly string[] = ["feat", "fix", "refactor", "chore", "docs", "test", "perf", "ci"];

const SCOPES: Record<string, string> = {
  backend: "server, API implementation, business logic",
  frontend: "web dashboard / UI",
  ai: "hosted agent, prompts, LLM routing",
  api: "agent-legible API surface & conventions",
  whatsapp: "WhatsApp channel integration",
  payments: "payment rails (Wompi / ePayco)",
  auth: "onboarding, consent, login",
  db: "schema / migrations",
  repo: "repo-wide tooling, config, hooks, CI",
  deps: "dependency bumps",
  docs: "documentation",
};

const SCOPE_LINES = Object.entries(SCOPES)
  .map(([scope, description]) => `  ${scope.padEnd(10)} ${description}`)
  .join("\n");

const COMMIT_MESSAGE_FORMAT = `Required commit message format:
type(scope): message

- concise body bullet
- another body bullet

type: ${TYPES.join(" | ")}

scope (pick the area the change touches):
${SCOPE_LINES}

body: required; every line must start with "- "`;

export const validateCommitHeader = (header: string): string[] => {
  const match = /^([a-z]+)\(([a-z0-9-]+)\): (.+)$/.exec(header);

  if (!match) {
    return ["Commit header must follow format: type(scope): message"];
  }

  const type = match[1];
  const scope = match[2];
  const summary = match[3];

  if (type === undefined || scope === undefined || summary === undefined) {
    return ["Commit header must follow format: type(scope): message"];
  }

  const errors: string[] = [];

  if (!TYPES.includes(type)) {
    errors.push(`Invalid type "${type}". Use one of: ${TYPES.join(", ")}`);
  }

  if (!Object.hasOwn(SCOPES, scope)) {
    errors.push(`Invalid scope "${scope}". Use one of: ${Object.keys(SCOPES).join(", ")}`);
  }

  return errors;
};

export const validateCommitMessage = (message: string): string[] => {
  const lines = message.split(/\r?\n/);
  const header = lines[0] ?? "";
  const headerErrors = validateCommitHeader(header);

  if (headerErrors.length > 0) {
    return headerErrors;
  }

  const bodyLines = lines
    .slice(2)
    .filter((line) => line.trim().length > 0 && !line.startsWith("#"));
  const badBodyLine = bodyLines.find((line) => !line.startsWith("- "));

  if (bodyLines.length === 0) {
    return ["Commit body must contain at least one bullet point (- description)"];
  }

  if (badBodyLine) {
    return ["Commit body must contain bullet points only (- description)"];
  }

  return [];
};

export const formatCommitMessageErrors = (errors: readonly string[]): string =>
  `${errors.join("\n")}\n\n${COMMIT_MESSAGE_FORMAT}`;

if (import.meta.main) {
  const messagePath = Bun.argv[2];

  if (!messagePath) {
    console.error("Usage: bun scripts/check-commit-message.ts <commit-msg-file>");
    process.exit(1);
  }

  const message = await Bun.file(messagePath).text();
  const errors = validateCommitMessage(message);

  if (errors.length > 0) {
    console.error(formatCommitMessageErrors(errors));
    process.exit(1);
  }
}
