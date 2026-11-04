import { it } from "@effect/vitest";
import { Effect, Exit, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";
import { inspectRecoveryTarget } from "./production-release";

const revision = "a".repeat(40);
const version = "18500000-0000-4000-8000-000000000001";
const namespaceId = "1".repeat(32);
const objectId = "2".repeat(64);
const callerVersion = "18500000-0000-4000-8000-000000000002";
const probe = {
  name: "recovery-probe",
  version: callerVersion,
  binding: "SERVING",
  proof: Redacted.make("test-only-proof"),
};
const target = {
  owner: "isolated-serving",
  className: "AuthoritativeSqliteStore",
  version,
  namespaceId,
  objectId,
  manifest: "sealed-artifact",
  epoch: "next-epoch",
};

it.effect(
  "refuses an asserted recovery target when the platform binding resolves to another namespace",
  () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) => {
        const path = new URL(request.url).pathname;
        let result: unknown = {
          id: version,
          resources: {
            bindings: [
              {
                type: "durable_object_namespace",
                name: "SQLITE_STORE",
                namespace_id: "3".repeat(32),
                class_name: target.className,
              },
              { name: "CF_VERSION_METADATA", type: "version_metadata" },
              { type: "plain_text", name: "SQLITE_STORE_NAMESPACE_ID", text: namespaceId },
              { type: "plain_text", name: "SQLITE_STORE_MANIFEST", text: target.manifest },
              { type: "plain_text", name: "SQLITE_STORE_EPOCH", text: target.epoch },
              { type: "plain_text", name: "RELEASE_GIT_SHA", text: revision },
            ],
          },
        };
        if (path.endsWith("/workers/subdomain")) {
          result = { subdomain: "proof-account" };
        } else if (path.endsWith("/namespaces")) {
          result = [
            { id: namespaceId, script: target.owner, class: target.className, use_sqlite: true },
          ];
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ success: true, result }))
        );
      });
      const inspected = yield* Effect.exit(
        inspectRecoveryTarget(
          { account: "test-account", token: "test-only", revision, probe },
          target,
          client
        )
      );
      expect(Exit.isFailure(inspected)).toBe(true);
    })
);

it.effect(
  "observes actual isolated bindings and refuses public routing or a mismatched runtime object",
  () =>
    Effect.gen(function* () {
      for (const fault of [
        "None",
        "Public",
        "Object",
        "Cron",
        "OwnerVersion",
        "CallerBinding",
        "CallerVersion",
      ] as const) {
        const observation = {
          enabled: fault === "Public",
          stored: fault !== "Object",
          cron: fault === "Cron",
          accepted: fault === "None",
        };
        const responses: Readonly<Record<string, unknown>> = {
          "/workers/subdomain": { subdomain: "proof-account" },
          [`/workers/scripts/${probe.name}/versions/${callerVersion}`]: {
            id: callerVersion,
            resources: {
              bindings: [
                {
                  name: "SERVING",
                  type: "durable_object_namespace",
                  namespace_id: fault === "CallerBinding" ? "f".repeat(32) : namespaceId,
                },
                { name: "CF_VERSION_METADATA", type: "version_metadata" },
              ],
            },
          },
          "/workers/durable_objects/namespaces": [
            { id: namespaceId, script: target.owner, class: target.className, use_sqlite: true },
          ],
          [`/workers/scripts/${target.owner}/versions/${version}`]: {
            id: version,
            resources: {
              bindings: [
                {
                  type: "durable_object_namespace",
                  name: "SQLITE_STORE",
                  namespace_id: namespaceId,
                },
                { name: "CF_VERSION_METADATA", type: "version_metadata" },
                { type: "plain_text", name: "SQLITE_STORE_NAMESPACE_ID", text: namespaceId },
                { type: "plain_text", name: "SQLITE_STORE_MANIFEST", text: target.manifest },
                { type: "plain_text", name: "SQLITE_STORE_EPOCH", text: target.epoch },
                { type: "plain_text", name: "RELEASE_GIT_SHA", text: revision },
              ],
            },
          },
          [`/workers/scripts/${target.owner}/routes`]: [],
          [`/workers/scripts/${target.owner}/subdomain`]: {
            enabled: observation.enabled,
            previews_enabled: false,
          },
          [`/workers/scripts/${target.owner}/schedules`]: {
            schedules: observation.cron ? [{}] : [],
          },
          [`/workers/scripts/${target.owner}/deployments`]: {
            deployments: [{ id: version, versions: [{ version_id: version, percentage: 100 }] }],
          },
        };
        const client = HttpClient.make((request) => {
          if (new URL(request.url).hostname.endsWith(".workers.dev")) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  {
                    callerVersion: fault === "CallerVersion" ? version : callerVersion,
                    objectName: "authoritative-v1",
                    expectedObjectId: objectId,
                    store: {
                      ownerVersion: fault === "OwnerVersion" ? callerVersion : version,
                      target: {
                        namespaceId,
                        objectId: observation.stored ? objectId : "f".repeat(64),
                        manifest: target.manifest,
                        epoch: target.epoch,
                      },
                      admission: "Closed",
                      activationId: "activation",
                      queryLeases: 0,
                      releaseBarrier: "Unqualified",
                    },
                  },
                  { headers: { "cache-control": "no-store" } }
                )
              )
            );
          }
          const path = new URL(request.url).pathname.replace(
            "/client/v4/accounts/test-account",
            ""
          );
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ success: true, result: responses[path] })
            )
          );
        });
        const inspected = yield* Effect.exit(
          inspectRecoveryTarget(
            { account: "test-account", token: "test-only", revision, probe },
            target,
            client
          )
        );
        expect(Exit.isSuccess(inspected)).toBe(observation.accepted);
        if (Exit.isSuccess(inspected)) {
          expect(inspected.value).toMatchObject({
            target: { namespaceId, objectId },
            observation: "TargetBindingsObserved",
          });
        }
      }
    })
);
