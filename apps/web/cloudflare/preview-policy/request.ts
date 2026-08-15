#!/usr/bin/env bun

import { Schema } from "effect";
import { requireArgument } from "./shared";

type PreviewRequest = {
  readonly number: number;
  readonly headSha: string;
};

const WorkflowRunEvent = Schema.Struct({
  workflow_run: Schema.Struct({
    conclusion: Schema.String,
    event: Schema.String,
    head_repository: Schema.Struct({ full_name: Schema.String }),
    head_sha: Schema.String,
    pull_requests: Schema.Array(Schema.Struct({ number: Schema.Finite })),
  }),
});
type WorkflowRunEventValue = typeof WorkflowRunEvent.Type;
type WorkflowRun = WorkflowRunEventValue["workflow_run"];

const PullRequest = Schema.Struct({
  number: Schema.Finite,
  state: Schema.String,
  head: Schema.Struct({
    sha: Schema.String,
    repo: Schema.Struct({ full_name: Schema.String }),
  }),
});

const decodeWorkflowRun = (event: unknown): WorkflowRun => {
  try {
    return Schema.decodeUnknownSync(WorkflowRunEvent)(event).workflow_run;
  } catch {
    throw new Error("workflow-run event is malformed");
  }
};

const successfulRun = (event: unknown): WorkflowRun => {
  const run = decodeWorkflowRun(event);
  if (run.conclusion !== "success" || run.event !== "pull_request") {
    throw new Error("trigger must be a successful pull-request workflow");
  }
  return run;
};

const sameRepositoryHead = (run: WorkflowRun, repository: string): string => {
  if (run.head_repository.full_name !== repository) {
    throw new Error("workflow head must belong to the same repository");
  }
  const headSha = run.head_sha;
  if (!/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new Error("workflow head SHA is invalid");
  }
  return headSha;
};

const associatedPullRequest = (run: WorkflowRun): number => {
  const associated = run.pull_requests;
  if (associated.length !== 1) {
    throw new Error("workflow must have exactly one associated pull request");
  }
  const number = associated[0]?.number;
  if (number === undefined || !Number.isInteger(number) || number <= 0) {
    throw new Error("associated pull request number is invalid");
  }
  return number;
};

/**
 * Returns the unique same-repository pull request identified by a successful workflow-run event.
 * Malformed, unsuccessful, fork, or ambiguous events are rejected.
 */
export const previewRequestFromEvent = (event: unknown, repository: string): PreviewRequest => {
  const run = successfulRun(event);
  return {
    headSha: sameRepositoryHead(run, repository),
    number: associatedPullRequest(run),
  };
};

/**
 * Authorizes one still-open pull request only when its repository, number, and current head exactly
 * match the successful workflow-run event; malformed or stale documents are rejected.
 */
export const validatePreviewRequest = (
  event: unknown,
  pullRequest: unknown,
  repository: string
): PreviewRequest => {
  const expected = previewRequestFromEvent(event, repository);
  let pullRequestRecord: typeof PullRequest.Type;
  try {
    pullRequestRecord = Schema.decodeUnknownSync(PullRequest)(pullRequest);
  } catch {
    throw new Error("pull request is malformed");
  }
  if (pullRequestRecord.number !== expected.number) {
    throw new Error("pull request is not associated with the workflow run");
  }
  if (pullRequestRecord.state !== "open") throw new Error("pull request is not open");
  const head = pullRequestRecord.head;
  if (head.repo.full_name !== repository) {
    throw new Error("pull request head must belong to the same repository");
  }
  if (head.sha !== expected.headSha) {
    throw new Error("pull request head SHA no longer matches the workflow run");
  }
  return expected;
};

const hasArgument = (name: string): boolean => Bun.argv.includes(`--${name}`);

if (import.meta.main) {
  const eventPath = requireArgument("event");
  const repository = requireArgument("repository");
  const event: unknown = JSON.parse(await Bun.file(eventPath).text());
  const request = hasArgument("pull-request")
    ? validatePreviewRequest(
        event,
        JSON.parse(await Bun.file(requireArgument("pull-request")).text()),
        repository
      )
    : previewRequestFromEvent(event, repository);
  process.stdout.write(`${request.number}\n`);
}
