import { describe, expect, it } from "vitest";
import { previewRequestFromEvent, validatePreviewRequest } from "./request";

const repository = "B4rz99/fidy-ai";
const headSha = "a".repeat(40);

type WorkflowRunFixture = {
  conclusion: string;
  event: string;
  head_repository: { full_name: string };
  head_sha: string;
  pull_requests: Array<{ number: number }>;
};

type WorkflowEventFixture = {
  workflow_run: WorkflowRunFixture;
};

type PullRequestFixture = {
  number: number;
  state: string;
  head: { sha: string; repo: { full_name: string } };
};

const workflowEvent = (): WorkflowEventFixture => ({
  workflow_run: {
    conclusion: "success",
    event: "pull_request",
    head_repository: { full_name: repository },
    head_sha: headSha,
    pull_requests: [{ number: 264 }],
  },
});

const pullRequest = (): PullRequestFixture => ({
  number: 264,
  state: "open",
  head: { sha: headSha, repo: { full_name: repository } },
});

describe("preview request policy", () => {
  it("accepts the exact open same-repository pull request", () => {
    expect(validatePreviewRequest(workflowEvent(), pullRequest(), repository)).toEqual({
      headSha,
      number: 264,
    });
  });

  it("rejects malformed workflow and pull-request documents", () => {
    expect(() => previewRequestFromEvent({ workflow_run: [] }, repository)).toThrow("malformed");
    expect(() => validatePreviewRequest(workflowEvent(), { head: [] }, repository)).toThrow(
      "malformed"
    );
  });

  it("rejects a non-pull-request or unsuccessful trigger", () => {
    for (const [field, value] of [
      ["event", "push"],
      ["conclusion", "failure"],
    ] as const) {
      const changed = workflowEvent();
      changed.workflow_run[field] = value;

      expect(() => previewRequestFromEvent(changed, repository)).toThrow("successful pull-request");
    }
  });

  it("rejects a fork", () => {
    const changedEvent = workflowEvent();
    changedEvent.workflow_run.head_repository.full_name = "fork/fidy-ai";
    expect(() => validatePreviewRequest(changedEvent, pullRequest(), repository)).toThrow(
      "same repository"
    );

    const changedPullRequest = pullRequest();
    changedPullRequest.head.repo.full_name = "fork/fidy-ai";
    expect(() => validatePreviewRequest(workflowEvent(), changedPullRequest, repository)).toThrow(
      "same repository"
    );
  });

  it("rejects a closed or stale pull request", () => {
    const closed = pullRequest();
    closed.state = "closed";
    expect(() => validatePreviewRequest(workflowEvent(), closed, repository)).toThrow("not open");

    const stale = pullRequest();
    stale.head.sha = "b".repeat(40);
    expect(() => validatePreviewRequest(workflowEvent(), stale, repository)).toThrow("head SHA");
  });

  it("rejects an unassociated pull request number", () => {
    const changed = pullRequest();
    changed.number = 265;

    expect(() => validatePreviewRequest(workflowEvent(), changed, repository)).toThrow(
      "associated"
    );
  });
});
