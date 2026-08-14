#!/usr/bin/env bun

import { type UnknownRecord, requireArgument, requireRecord } from "./shared";

type PreviewRequest = {
  readonly number: number;
  readonly headSha: string;
};

const successfulRun = (event: unknown): UnknownRecord => {
  const run = requireRecord(
    requireRecord(event, "workflow-run event").workflow_run,
    "workflow run"
  );
  if (run.conclusion !== "success" || run.event !== "pull_request") {
    throw new Error("trigger must be a successful pull-request workflow");
  }
  return run;
};

const sameRepositoryHead = (run: UnknownRecord, repository: string): string => {
  const runRepository = requireRecord(run.head_repository, "workflow head repository");
  if (runRepository.full_name !== repository) {
    throw new Error("workflow head must belong to the same repository");
  }
  const headSha = run.head_sha;
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new Error("workflow head SHA is invalid");
  }
  return headSha;
};

const associatedPullRequest = (run: UnknownRecord): number => {
  const associated = run.pull_requests;
  if (!Array.isArray(associated) || associated.length !== 1) {
    throw new Error("workflow must have exactly one associated pull request");
  }
  const number = requireRecord(associated[0], "associated pull request").number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
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
  const pullRequestRecord = requireRecord(pullRequest, "pull request");
  if (pullRequestRecord.number !== expected.number) {
    throw new Error("pull request is not associated with the workflow run");
  }
  if (pullRequestRecord.state !== "open") throw new Error("pull request is not open");
  const head = requireRecord(pullRequestRecord.head, "pull request head");
  const headRepository = requireRecord(head.repo, "pull request head repository");
  if (headRepository.full_name !== repository) {
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
