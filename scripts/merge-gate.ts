#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Data, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { selectChecks, selectNativeChecks } from "./ci-changes";

export type CiJob = Readonly<{ name: string; conclusion: string }>;

type Plan = ReturnType<typeof selectChecks>;

type Group = Readonly<{ names: ReadonlyArray<string>; selected: boolean }>;

class MergeGateFailure extends Data.TaggedError("MergeGateFailure")<{
  readonly reason: string;
}> {}

const okStatus = 200;

const redirectStatus = 300;

const pageLimit = 100;

const alwaysSuccessful = ["Select affected checks", "Workspace Gate", "Secrets"] as const;

const failedConclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "startup_failure",
  "timed_out",
]);

const jobMatches = (job: CiJob, name: string): boolean =>
  job.name === name || job.name.startsWith(name + " (");

const selectedGroups = (plan: Plan, native: boolean): ReadonlyArray<Group> => [
  { names: ["Builds"], selected: plan.builds },
  { names: ["Unit and artifact tests"], selected: plan.unit },
  { names: ["Cloudflare adapters"], selected: plan["cloudflare-adapters"] },
  { names: ["Cloudflare infrastructure tests"], selected: plan["cloudflare-infra"] },
  { names: ["SAST"], selected: plan["security-sast"] },
  { names: ["SCA"], selected: plan["security-sca"] },
  {
    names: ["CLI native store", "Package CLI native conformance"],
    selected: native,
  },
];

const groupReasons = (group: Group, jobs: ReadonlyArray<CiJob>): ReadonlyArray<string> => {
  const present = jobs.filter((job) => group.names.some((name) => jobMatches(job, name)));

  if (!group.selected) {
    return present.flatMap((job) =>
      job.conclusion === "skipped" ? [] : [`${job.name} was not selected but ran`]
    );
  }

  if (present.length === 0) {
    return [`${group.names[0]} was selected but did not report`];
  }

  return present.flatMap((job) =>
    job.conclusion === "success" ? [] : [`${job.name} concluded ${job.conclusion}`]
  );
};

const alwaysReasons = (jobs: ReadonlyArray<CiJob>): ReadonlyArray<string> =>
  alwaysSuccessful.flatMap((name) => {
    const job = jobs.find((entry) => entry.name === name);

    if (job === undefined) {
      return [`${name} did not report`];
    }

    return job.conclusion === "success" ? [] : [`${name} concluded ${job.conclusion}`];
  });

export type MergeGateVerdict = Readonly<{
  passed: boolean;
  reasons: ReadonlyArray<string>;
}>;

export const evaluateMergeGate = (
  input: Readonly<{
    plan: Plan;
    native: boolean;
    jobs: ReadonlyArray<CiJob>;
    runConclusion: string;
  }>
): MergeGateVerdict => {
  const conclusionReasons =
    input.runConclusion === "success" ? [] : [`the Checks run concluded ${input.runConclusion}`];

  const reasons = [
    ...conclusionReasons,
    ...alwaysReasons(input.jobs),
    ...selectedGroups(input.plan, input.native).flatMap((group) => groupReasons(group, input.jobs)),
    ...input.jobs.flatMap((job) =>
      failedConclusions.has(job.conclusion) ? [`${job.name} concluded ${job.conclusion}`] : []
    ),
  ];

  return { passed: reasons.length === 0, reasons: [...new Set(reasons)] };
};

const Pull = Schema.Struct({ base: Schema.Struct({ sha: Schema.String }) });

const JobsPage = Schema.Struct({
  jobs: Schema.Array(Schema.Struct({ name: Schema.String, conclusion: Schema.String })),
});

const StatusBody = Schema.Struct({
  context: Schema.String,
  description: Schema.String,
  state: Schema.Literals(["success", "failure"]),
});

const failure = (reason: string): MergeGateFailure => new MergeGateFailure({ reason });

const required = (name: string): string => {
  const value = Bun.env[name];

  if (value === undefined || value.length === 0) throw failure(`${name} is required`);

  return value;
};

const api = (path: string): string => "https://api.github.com" + path;

const authorized = (
  request: HttpClientRequest.HttpClientRequest
): HttpClientRequest.HttpClientRequest =>
  request.pipe(
    HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
    HttpClientRequest.setHeader("authorization", `Bearer ${required("GH_TOKEN")}`),
    HttpClientRequest.setHeader("x-github-api-version", "2022-11-28")
  );

const readText = (path: string): Effect.Effect<string, MergeGateFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const response = yield* client
      .execute(authorized(HttpClientRequest.get(api(path))))
      .pipe(Effect.mapError((cause) => failure(String(cause))));

    if (response.status < okStatus || response.status >= redirectStatus) {
      return yield* failure(`GitHub API ${path} returned ${response.status}`);
    }

    return yield* response.text.pipe(Effect.mapError((cause) => failure(String(cause))));
  });

const report = (input: {
  readonly repository: string;
  readonly head: string;
  readonly state: "success" | "failure";
  readonly description: string;
}): Effect.Effect<void, MergeGateFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{40}$/u.test(input.head)) {
      return;
    }

    const client = yield* HttpClient.HttpClient;

    const body = yield* Schema.encodeEffect(Schema.fromJsonString(StatusBody))({
      context: "Required Checks",
      description: input.description,
      state: input.state,
    }).pipe(Effect.mapError((cause) => failure(String(cause))));

    const response = yield* client
      .execute(
        authorized(
          HttpClientRequest.post(api(`/repos/${input.repository}/statuses/${input.head}`)).pipe(
            HttpClientRequest.bodyText(body, "application/json")
          )
        )
      )
      .pipe(Effect.mapError((cause) => failure(String(cause))));

    if (response.status < okStatus || response.status >= redirectStatus) {
      return yield* failure(`the status update returned ${response.status}`);
    }
  });

const changedPaths = (
  pullNumber: string,
  base: string
): Effect.Effect<ReadonlyArray<string>, MergeGateFailure> =>
  Effect.try({
    try: () => {
      const fetched = Bun.spawnSync([
        "git",
        "fetch",
        "--no-tags",
        "origin",
        `+refs/pull/${pullNumber}/head:refs/remotes/pull/head`,
      ]);

      if (fetched.exitCode !== 0) throw new Error("cannot fetch the pull request commits");

      const diff = Bun.spawnSync([
        "git",
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        `${base}...refs/remotes/pull/head`,
      ]);

      if (diff.exitCode !== 0) throw new Error("cannot determine the pull request diff");

      return new TextDecoder().decode(diff.stdout).split("\0").filter(Boolean);
    },
    catch: (cause) => failure(String(cause)),
  });

const readPlan = (
  repository: string,
  pullNumber: string
): Effect.Effect<
  Readonly<{ native: boolean; plan: Plan }>,
  MergeGateFailure,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const pull = yield* readText(`/repos/${repository}/pulls/${pullNumber}`);

    const base = yield* Schema.decodeEffect(Schema.fromJsonString(Pull))(pull).pipe(
      Effect.mapError((cause) => failure(String(cause)))
    );

    const paths = yield* changedPaths(pullNumber, base.base.sha);

    return { native: selectNativeChecks(paths), plan: selectChecks(paths) };
  });

const readJobs = (
  repository: string,
  runId: string
): Effect.Effect<ReadonlyArray<CiJob>, MergeGateFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const text = yield* readText(
      `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=1`
    );

    const page = yield* Schema.decodeEffect(Schema.fromJsonString(JobsPage))(text).pipe(
      Effect.mapError((cause) => failure(String(cause)))
    );

    if (page.jobs.length === pageLimit) {
      return yield* failure("the run reports too many jobs");
    }

    return page.jobs;
  });

const coordinates = Effect.gen(function* () {
  const head = Bun.env.HEAD_SHA ?? "";
  const pullNumber = Bun.env.PR_NUMBER ?? "";

  if (!/^[0-9a-f]{40}$/u.test(head)) {
    return yield* failure("HEAD_SHA is unavailable");
  }

  if (!/^\d+$/u.test(pullNumber)) {
    return yield* failure("PR_NUMBER is unavailable");
  }

  return { head, pullNumber };
});

const run = Effect.gen(function* () {
  const repository = required("REPOSITORY");
  const runId = required("RUN_ID");
  const runConclusion = required("RUN_CONCLUSION");
  const { head, pullNumber } = yield* coordinates;

  const { native, plan } = yield* readPlan(repository, pullNumber);
  const jobs = yield* readJobs(repository, runId);
  const verdict = evaluateMergeGate({ jobs, native, plan, runConclusion });

  yield* report({
    repository,
    head,
    state: verdict.passed ? "success" : "failure",
    description: verdict.passed
      ? "Selected checks passed"
      : (verdict.reasons[0] ?? "Merge gate failed"),
  });

  yield* Effect.sync(() => {
    if (verdict.passed) {
      process.stdout.write("Merge gate passed.\n");

      return;
    }

    process.stderr.write(verdict.reasons.join("\n") + "\n");
    process.exitCode = 1;
  });
});

const entry = run.pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        process.stderr.write(error.reason + "\n");
        process.exitCode = 1;
      });

      const repository = Bun.env.REPOSITORY ?? "";

      if (repository.length === 0) {
        return;
      }

      yield* report({
        repository,
        head: Bun.env.HEAD_SHA ?? "",
        state: "failure",
        description: "Merge gate could not verify the run",
      }).pipe(Effect.ignore);
    })
  )
);

if (import.meta.main) BunRuntime.runMain(entry.pipe(Effect.provide(FetchHttpClient.layer)));
