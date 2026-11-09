import { type Cause, Effect, FileSystem, Schema } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Miniflare } from "miniflare";
import { makeRemoteErasureRegistry } from "./runtime";
import type { ErasureRegistry } from "./contract";

const ObjectRow = Schema.Struct({ etag: Schema.String, size: Schema.Int, value: Schema.String });
const PutRow = Schema.NullOr(Schema.Struct({ etag: Schema.String }));
const Page = Schema.Struct({
  objects: Schema.Array(Schema.Struct({ key: Schema.String })),
  truncated: Schema.Boolean,
  cursor: Schema.optionalKey(Schema.String),
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const generation = "12740000-0000-4000-8000-000000000088";
const generationKey = "recovery/generation";
const caseKey = (index: number): string =>
  `recovery/cases/12740000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const remoteRegistry = (runtime: () => Miniflare): ErasureRegistry =>
  makeRemoteErasureRegistry({
    fetch: (input, init) => {
      const request = new Request(input, init);
      return request
        .text()
        .then((body) =>
          runtime()
            .getDurableObjectNamespace("REGISTRY")
            .then((namespace) =>
              namespace.getByName("independent-authority").fetch(request.url, {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                body,
              })
            )
        )
        .then((response) =>
          response.text().then(
            (body) =>
              new Response(body, {
                status: response.status,
                headers: Object.fromEntries(response.headers),
              })
          )
        );
    },
  });

const verifyRegistry = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-registry-" });
  const build = yield* Effect.tryPromise(() =>
    Bun.build({
      entrypoints: [new URL("./registry.test-fixture.ts", import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers"],
    })
  );
  const output = build.outputs[0];
  if (!build.success || output === undefined) {
    return yield* Effect.die(new Error("Registry fixture build failed"));
  }
  const contents = yield* Effect.tryPromise(() => output.text());
  const create = (): Miniflare =>
    new Miniflare({
      resourcePersistencePath: directory,
      workers: [
        {
          config: {
            name: "registry-fixture",
            type: "worker",
            compatibilityDate: "2026-09-08",
            exports: { RegistryFixture: { type: "durable-object", storage: "sqlite" } },
            env: {
              REGISTRY: {
                type: "durable-object",
                worker: "registry-fixture",
                exportName: "RegistryFixture",
              },
            },
            manifest: {
              mainModule: "index.mjs",
              modules: { "index.mjs": { type: "esm", contents } },
            },
          },
        },
      ],
    });
  let runtime = create();
  yield* Effect.addFinalizer(() => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie));
  const request = (
    command: unknown
  ): Effect.Effect<Pick<Response, "status" | "json">, Cause.UnknownError> =>
    Effect.tryPromise(() =>
      runtime
        .getDurableObjectNamespace("REGISTRY")
        .then((namespace) =>
          namespace
            .getByName("independent-authority")
            .fetch("https://fixture.internal", { method: "POST", body: encodeJson(command) })
        )
    );
  const read = <Shape extends Schema.ConstraintDecoder<unknown>>(
    command: unknown,
    schema: Shape
  ): Effect.Effect<Shape["Type"], Cause.UnknownError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const response = yield* request(command);
      expect(response.status).toBe(200);
      return yield* Schema.decodeUnknownEffect(schema)(
        yield* Effect.tryPromise(() => response.json())
      );
    });
  expect(yield* read({ action: "get", key: generationKey }, Schema.Null)).toBeNull();
  const initial = yield* read(
    {
      action: "put",
      key: generationKey,
      value: "initial",
      options: { onlyIf: { etagDoesNotMatch: "*" } },
    },
    PutRow
  );
  expect(initial).not.toBeNull();
  if (initial === null) return yield* Effect.die(new Error("Fixture initialization failed"));
  const initialEtag = initial.etag;
  const publication = {
    action: "put",
    key: generationKey,
    value: generation,
    options: { onlyIf: { etagMatches: initialEtag } },
  };
  const rivals = yield* Effect.all([read(publication, PutRow), read(publication, PutRow)], {
    concurrency: "unbounded",
  });
  expect(rivals.filter((row) => row !== null)).toHaveLength(1);
  expect((yield* read({ action: "get", key: generationKey }, ObjectRow)).value).toBe(generation);
  for (let index = 1; index <= 35; index++) {
    const value = encodeJson({
      reference: caseKey(index).slice("recovery/cases/".length),
      userId: "12740000-0000-4000-8000-000000000001",
      requestedAtMs: 1,
      sealed: true,
    });
    expect(
      yield* read(
        {
          action: "put",
          key: caseKey(index),
          value,
          options: { onlyIf: { etagDoesNotMatch: "*" } },
        },
        PutRow
      )
    ).not.toBeNull();
  }
  const first = yield* read(
    { action: "list", options: { prefix: "recovery/cases/", limit: 32 } },
    Page
  );
  expect(first.objects.map((row) => row.key)).toEqual(
    Array.from({ length: 32 }, (_, index) => caseKey(index + 1))
  );
  expect(first.truncated).toBe(true);
  const last = yield* read(
    {
      action: "list",
      options: { prefix: "recovery/cases/", limit: 32, cursor: first.cursor },
    },
    Page
  );
  expect(last).toEqual({
    objects: [33, 34, 35].map((index) => ({ key: caseKey(index) })),
    truncated: false,
  });
  for (const command of [
    {
      action: "put",
      key: "users/private-original",
      value: "x".repeat(80000),
      options: { onlyIf: { etagDoesNotMatch: "*" } },
    },
    {
      action: "put",
      key: caseKey(36),
      value: encodeJson({
        reference: caseKey(35).slice("recovery/cases/".length),
        userId: "12740000-0000-4000-8000-000000000001",
        requestedAtMs: 1,
        sealed: true,
      }),
      options: { onlyIf: { etagDoesNotMatch: "*" } },
    },
    { action: "list", options: { prefix: "users/", limit: 32 } },
    { action: "list", options: { prefix: "recovery/cases/", limit: 33 } },
    {
      action: "list",
      options: {
        prefix: "recovery/cases/",
        limit: 32,
        cursor: encodeJson({ prefix: "", after: caseKey(1) }),
      },
    },
  ]) {
    expect((yield* request(command)).status).toBe(503);
  }
  expect(yield* read({ action: "get", key: caseKey(36) }, Schema.Null)).toBeNull();
  const remote = remoteRegistry(() => runtime);
  const remoteGeneration = yield* Effect.tryPromise(() => remote.get(generationKey));
  expect(
    yield* Effect.tryPromise(() => remoteGeneration?.text() ?? Promise.resolve("missing"))
  ).toBe(generation);
  const remotePage = yield* Effect.tryPromise(() =>
    remote.list({ prefix: "recovery/cases/", limit: 32 })
  );
  expect(remotePage.objects.map((row) => row.key)).toEqual(first.objects.map((row) => row.key));
  expect(remotePage.truncated).toBe(true);
  const remoteValue = encodeJson({
    reference: caseKey(36).slice("recovery/cases/".length),
    userId: "12740000-0000-4000-8000-000000000001",
    requestedAtMs: 1,
    sealed: false,
  });
  expect(
    yield* Effect.tryPromise(() =>
      remote.put(caseKey(36), remoteValue, { onlyIf: { etagDoesNotMatch: "*" } })
    )
  ).not.toBeNull();
  expect(
    yield* Effect.tryPromise(() =>
      remote.put(caseKey(36), remoteValue, { onlyIf: { etagDoesNotMatch: "*" } })
    )
  ).toBeNull();
  const remoteCase = yield* Effect.tryPromise(() => remote.get(caseKey(36)));
  expect(yield* Effect.tryPromise(() => remoteCase?.text() ?? Promise.resolve("missing"))).toBe(
    remoteValue
  );
  yield* Effect.tryPromise(() => remote.delete(caseKey(36)));
  expect(yield* Effect.tryPromise(() => remote.head(caseKey(36)))).toBeNull();
  yield* Effect.tryPromise(() => runtime.dispose());
  runtime = create();
  expect((yield* read({ action: "get", key: generationKey }, ObjectRow)).value).toBe(generation);
  yield* read({ action: "refuse-writes" }, Schema.Null);
  const current = yield* read(
    { action: "head", key: generationKey },
    Schema.Struct({ etag: Schema.String })
  );
  expect(
    (yield* request({
      ...publication,
      value: "initial",
      options: { onlyIf: { etagMatches: current.etag } },
    })).status
  ).toBe(503);
  expect((yield* read({ action: "get", key: generationKey }, ObjectRow)).value).toBe(generation);
  yield* read({ action: "lose" }, Schema.Null);
  expect(yield* read({ action: "get", key: generationKey }, Schema.Null)).toBeNull();
  expect(yield* Effect.tryPromise(() => remote.get(generationKey))).toBeNull();
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "persists independent metadata, fences competing publication, and bounds ordered recovery traversal",
    () => verifyRegistry,
    { timeout: 30000 }
  );
});
