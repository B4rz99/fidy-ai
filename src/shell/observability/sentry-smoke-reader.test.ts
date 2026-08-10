import { expect, it } from "@effect/vitest";
import { Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { type DeploymentSmokeEmission, deploymentSmokeSourceLocation } from "./deployment-smoke";
import { TelemetryTraceId } from "./protocol";
import {
  SentrySmokeReadError,
  inspectDeploymentSmoke,
  projectDeploymentSmokeResponses,
} from "./sentry-smoke-reader";
import type { TelemetryRelease } from "./telemetry-config";

const json = (value: unknown): string =>
  Schema.encodeUnknownSync(Schema.UnknownFromJsonString)(value);
const unauthorizedStatus = 401;
const release: TelemetryRelease = "fidy@0123456789abcdef0123456789abcdef01234567";
const traceId = TelemetryTraceId.make("0123456789abcdef0123456789abcdef");
const emission: DeploymentSmokeEmission = {
  traceId,
  publicationContext: Option.none(),
  providerHeadersAreIsolated: true,
};

const traceNode = (name: string, op: string, children: ReadonlyArray<unknown> = []): unknown => ({
  transaction: name,
  op,
  children,
});

const traceNodeWithData = (name: string, op: string, data: unknown): unknown => ({
  transaction: name,
  op,
  children: [],
  data,
});

const eventJson = json([
  {
    id: "a".repeat(32),
    message: "",
    user: null,
    tags: [
      { key: "release", value: release },
      { key: "component", value: "ci" },
      { key: "operation", value: "observability.deploymentSmokeDefect" },
      { key: "error", value: "deployment_smoke_defect" },
    ],
    entries: [
      {
        type: "exception",
        data: {
          values: [
            {
              type: "FidyDefect",
              value: "Unexpected defect",
              stacktrace: {
                frames: [
                  {
                    module: deploymentSmokeSourceLocation.module,
                    filename: deploymentSmokeSourceLocation.file,
                    function: deploymentSmokeSourceLocation.function,
                    lineNo: deploymentSmokeSourceLocation.line,
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    contexts: { trace: { trace_id: traceId } },
    _meta: { providerOwnedProcessingMetadata: "drop-me" },
  },
]);

const traceJson = (providerData: Option.Option<unknown>): string =>
  json([
    traceNode("POST /deployment-smoke", "http.server", [
      traceNode("observability.deploymentSmokePublish", "queue.publish", [
        traceNode("observability.deploymentSmokeProcess", "queue.process", [
          traceNode("observability.deploymentSmokeAgent", "agent.turn", [
            traceNode("observability.deploymentSmokeModel", "agent.model", [
              Option.match(providerData, {
                onNone: () => traceNode("observability.deploymentSmokeProvider", "http.client"),
                onSome: (data) =>
                  traceNodeWithData("observability.deploymentSmokeProvider", "http.client", data),
              }),
            ]),
          ]),
          traceNode("observability.deploymentSmokeExpectedOutcome", "fidy.operation"),
        ]),
      ]),
    ]),
  ]);

const project = (retrievedTraceJson: string): ReturnType<typeof projectDeploymentSmokeResponses> =>
  projectDeploymentSmokeResponses({
    release,
    emission,
    flushCompleted: true,
    issuesJson: json([{ id: "1234", count: "1", privateLocator: "drop-me" }]),
    expectedOutcomeIssuesJson: json([]),
    eventsJson: eventJson,
    traceJson: retrievedTraceJson,
  });

it.effect("replaces authenticated API failures with fixed secret-free metadata", () =>
  Effect.gen(function* () {
    const token = "deployment-reader-token-sentinel";
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("private-response-sentinel", { status: unauthorizedStatus })
        )
      )
    );
    const error = yield* inspectDeploymentSmoke({
      config: {
        authToken: Redacted.make(token),
        organizationSlug: Redacted.make("private-organization"),
        projectSlug: Redacted.make("private-project"),
      },
      release,
      emission,
      flushCompleted: true,
    }).pipe(Effect.flip, Effect.provideService(HttpClient.HttpClient, client));

    expect(error).toEqual(SentrySmokeReadError.make({ reason: "unauthorized" }));
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain("private-response-sentinel");
  })
);

it.effect("projects bounded Sentry responses after validating telemetry channels", () =>
  Effect.gen(function* () {
    const observation = yield* Option.none().pipe(traceJson, project);

    expect(observation).toMatchObject({
      issueCount: 1,
      eventCount: 1,
      release,
      traceId,
      projectedFieldsOnly: true,
      sentinelsAbsent: true,
      expectedOutcomeIssueCount: 0,
    });
    expect(observation).not.toHaveProperty("privateLocator");
    expect(observation.defect).not.toHaveProperty("providerOwnedProcessingMetadata");
  })
);

it.effect("rejects provider-private data in a retrieved trace channel", () =>
  Effect.gen(function* () {
    const observation = yield* Option.some({ providerResponseBody: "private" }).pipe(
      traceJson,
      project
    );

    expect(observation.projectedFieldsOnly).toBe(false);
  })
);
