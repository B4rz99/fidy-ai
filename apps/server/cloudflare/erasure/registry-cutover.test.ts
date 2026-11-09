import { Clock, Effect, FileSystem, Schema } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Miniflare } from "miniflare";
import { installCurrentTestObjects } from "../d1-test-fixture";
import { erasureRegistryName } from "./contract";

const generationKey = "recovery/generation";
const replacement = "12740000-0000-4000-8000-000000000088";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const native = <Value>(run: () => Promise<Value>): Effect.Effect<Value> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const platform = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-registry-cutover-" });
  const build = yield* native(() =>
    Bun.build({
      entrypoints: [new URL("./registry-cutover.test-fixture.ts", import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers"],
    })
  );
  const output = build.outputs[0];
  if (!build.success || output === undefined) {
    return yield* Effect.die(new Error("Registry cutover fixture build failed"));
  }
  const contents = yield* native(() => output.text());
  const create = (): Miniflare =>
    new Miniflare({
      resourcePersistencePath: directory,
      workers: [
        {
          config: {
            name: "registry-cutover-fixture",
            type: "worker",
            compatibilityDate: "2026-09-08",
            exports: {
              RegistryCutoverFixture: { type: "durable-object", storage: "sqlite" },
              RegistryOwnerFixture: { type: "durable-object", storage: "sqlite" },
              RegistryCallbackFixture: { type: "durable-object", storage: "sqlite" },
              DeployedRegistryFixture: { type: "durable-object", storage: "sqlite" },
              DeployedTransportFixture: { type: "worker" },
            },
            env: {
              DB: { type: "d1", id: "registry-cutover" },
              ERASURE_BUCKET: { type: "r2", name: "registry-cutover" },
              RELEASE_GIT_SHA: { type: "text", value: "native-root-fixture" },
              ROOT_COORDINATOR: {
                type: "durable-object",
                worker: "registry-cutover-fixture",
                exportName: "DeployedRegistryFixture",
              },
              METADATA_TRANSPORT: {
                type: "worker",
                worker: "registry-cutover-fixture",
                exportName: "DeployedTransportFixture",
              },
              ERASURE_REGISTRY_COORDINATOR: {
                type: "durable-object",
                worker: "registry-cutover-fixture",
                exportName: "RegistryOwnerFixture",
              },
              CALLBACK: {
                type: "durable-object",
                worker: "registry-cutover-fixture",
                exportName: "RegistryCallbackFixture",
              },
              REGISTRY: {
                type: "durable-object",
                worker: "registry-cutover-fixture",
                exportName: "RegistryCutoverFixture",
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
  yield* Effect.addFinalizer(() => native(() => runtime.dispose()));
  const db = yield* native(() => runtime.getD1Database("DB"));
  const { ERASURE_BUCKET: bucket } = yield* native(() =>
    runtime.getBindings<{ ERASURE_BUCKET: R2Bucket }>()
  );
  yield* native(() => installCurrentTestObjects({ db, tables: [] }));
  yield* native(() => bucket.put(generationKey, "initial"));
  const request = (command: string): Effect.Effect<Pick<Response, "status" | "json">> =>
    native(() =>
      runtime.getDurableObjectNamespace("REGISTRY").then((namespace) =>
        namespace.getByName("authority").fetch("https://fixture.internal", {
          method: "POST",
          body: encode(command),
        })
      )
    );
  const read = (command: string): Effect.Effect<string, Schema.SchemaError> =>
    Effect.gen(function* () {
      const response = yield* request(command);
      expect(response.status).toBe(200);
      return yield* Schema.decodeUnknownEffect(Schema.String)(yield* native(() => response.json()));
    });
  return {
    db,
    bucket,
    request,
    read,
    transport: (url: string, body: string): Effect.Effect<Pick<Response, "status" | "json">> =>
      native(() =>
        runtime
          .getBindings<{ METADATA_TRANSPORT: Pick<Fetcher, "fetch"> }>()
          .then(({ METADATA_TRANSPORT }) =>
            METADATA_TRANSPORT.fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            })
          )
      ),
    root: (url: string, body: string): Effect.Effect<Pick<Response, "status" | "json">> =>
      native(() =>
        runtime
          .getDurableObjectNamespace("ROOT_COORDINATOR")
          .then((namespace) =>
            namespace
              .getByName(erasureRegistryName)
              .fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })
          )
      ),
    owner: (
      input:
        | Readonly<{ url: string }>
        | Readonly<{ url: string; body: string }>
        | Readonly<{ url: string; name: string }>
    ): Effect.Effect<Pick<Response, "status" | "json">> =>
      native(() =>
        runtime.getDurableObjectNamespace("ERASURE_REGISTRY_COORDINATOR").then((namespace) =>
          namespace.getByName("name" in input ? input.name : erasureRegistryName).fetch(
            input.url,
            "body" in input
              ? {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: input.body,
                }
              : {}
          )
        )
      ),
    restart: (): Effect.Effect<void> =>
      native(() => runtime.dispose()).pipe(
        Effect.andThen(
          Effect.sync(() => {
            runtime = create();
          })
        )
      ),
    checkpoint: (): Effect.Effect<unknown> =>
      native(() =>
        db
          .prepare("SELECT generation FROM erasure_control WHERE kind='published'")
          .first("generation")
      ),
  };
});
it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "dispatches the deployed coordinator's reserved object without constructing User work",
    () =>
      Effect.gen(function* () {
        const fixture = yield* platform;
        const read = encode({ action: "get", key: generationKey });
        const before = yield* fixture.root("https://erasure-registry.invalid/metadata", read);
        expect(before.status).toBe(200);
        const current = yield* Clock.currentTimeMillis;
        expect(
          (yield* fixture.root(
            "https://erasure-registry.invalid/migrate",
            encode({
              deadlineMs: current + 5000,
              authority: {
                permission: "titular.erase",
                operatorRef: "fixture",
                expiresAtMs: current + 10000,
              },
            })
          )).status
        ).toBe(200);
        expect(yield* fixture.checkpoint()).not.toBe("initial");
        const after = yield* fixture.root("https://erasure-registry.invalid/metadata", read);
        expect(after.status).toBe(200);
        expect(
          (yield* fixture.transport("https://erasure-registry.invalid/metadata", read)).status
        ).toBe(200);
        expect(
          (yield* fixture.transport("https://erasure-registry.invalid/migrate", "{}")).status
        ).toBe(404);
        expect((yield* fixture.transport("https://read.internal/categories", "{}")).status).toBe(
          404
        );
        expect((yield* fixture.root("https://read.internal/transactions", "{}")).status).toBe(404);
      })
  );
  test.effect(
    "keeps native owner reads and callback recovery fresh across bounded migration admission",
    () =>
      Effect.gen(function* () {
        const fixture = yield* platform;
        expect((yield* fixture.owner({ url: "https://read.internal" })).status).toBe(200);
        expect(
          (yield* fixture.owner({ url: "https://read.internal", name: "wrong-owner" })).status
        ).toBe(503);
        const now = yield* Clock.currentTimeMillis;
        const admission = {
          deadlineMs: now + 5000,
          authority: {
            permission: "titular.erase",
            operatorRef: "fixture",
            expiresAtMs: now + 10000,
          },
        };
        for (const value of [
          {},
          { ...admission, deadlineMs: now - 1 },
          { ...admission, deadlineMs: now + 6000 },
          { ...admission, authority: { ...admission.authority, permission: "other" } },
          { ...admission, authority: { ...admission.authority, expiresAtMs: now - 1 } },
        ]) {
          expect(
            (yield* fixture.owner({
              url: "https://erasure-registry.invalid/migrate",
              body: encode(value),
            })).status
          ).toBe(503);
          expect(yield* fixture.checkpoint()).toBe("initial");
        }
        expect(
          (yield* fixture.owner({
            url: "https://erasure-registry.invalid/migrate",
            body: encode(admission),
          })).status
        ).toBe(200);
        expect((yield* fixture.owner({ url: "https://read.internal" })).status).toBe(200);
        expect((yield* fixture.owner({ url: "https://read.internal/callback" })).status).toBe(200);
        yield* native(() =>
          fixture.db
            .prepare("UPDATE erasure_control SET generation='initial' WHERE kind='published'")
            .run()
        );
        expect((yield* fixture.owner({ url: "https://read.internal" })).status).toBe(503);
        expect((yield* fixture.owner({ url: "https://read.internal/callback" })).status).toBe(503);
      })
  );
  test.effect(
    "moves empty recovery metadata once, survives restart and preserves newer generations",
    () =>
      Effect.gen(function* () {
        const fixture = yield* platform;
        const privateValue = "private-original".repeat(6000);
        yield* native(() => fixture.bucket.put("private/original", privateValue));
        expect(yield* fixture.read("read")).toBe("initial");
        expect(yield* fixture.read("migrate")).toBe("Complete");
        const selected = yield* fixture.read("read");
        expect(selected).not.toBe("initial");
        expect(yield* fixture.checkpoint()).toBe(selected);
        const witness = yield* native(() => fixture.bucket.get(generationKey));
        expect(
          yield* native(
            () => witness?.text() ?? Promise.reject(new Error("Missing transfer witness"))
          )
        ).toBe(`publishing:${selected}:migrating`);
        const original = yield* native(() => fixture.bucket.get("private/original"));
        expect(
          yield* native(
            () => original?.text() ?? Promise.reject(new Error("Missing private original"))
          )
        ).toBe(privateValue);
        yield* fixture.request("advance");
        yield* native(() =>
          fixture.db
            .prepare("UPDATE erasure_control SET generation=? WHERE kind='published'")
            .bind(replacement)
            .run()
        );
        expect(yield* fixture.read("migrate")).toBe("Complete");
        expect(yield* fixture.read("read")).toBe(replacement);
        expect(yield* fixture.checkpoint()).toBe(replacement);
        yield* fixture.restart();
        expect(yield* fixture.read("migrate")).toBe("Complete");
        expect(yield* fixture.read("read")).toBe(replacement);
      })
  );

  test.effect("retries a lost R2 claim acknowledgement without claiming twice", () =>
    Effect.gen(function* () {
      const fixture = yield* platform;
      expect((yield* fixture.request("claim-loss")).status).toBe(503);
      expect(yield* fixture.checkpoint()).toBe("initial");
      const claimed = yield* native(() => fixture.bucket.head(generationKey));
      expect(yield* fixture.read("migrate")).toBe("Complete");
      expect((yield* native(() => fixture.bucket.head(generationKey)))?.etag).toBe(claimed?.etag);
    })
  );

  test.effect("rolls back failed SQLite publication and resumes without advancing D1 early", () =>
    Effect.gen(function* () {
      const fixture = yield* platform;
      yield* fixture.request("refuse-publication");
      expect((yield* fixture.request("migrate")).status).toBe(503);
      expect(yield* fixture.checkpoint()).toBe("initial");
      yield* fixture.request("allow-publication");
      expect(yield* fixture.read("migrate")).toBe("Complete");
    })
  );

  test.effect(
    "never retries an uncertain D1 publication or retags an old restored checkpoint",
    () =>
      Effect.gen(function* () {
        const fixture = yield* platform;
        yield* native(() =>
          fixture.db
            .prepare(
              "CREATE TRIGGER refuse_cutover BEFORE UPDATE ON erasure_control BEGIN SELECT RAISE(ABORT,'fixture_refusal'); END"
            )
            .run()
        );
        expect((yield* fixture.request("migrate")).status).toBe(503);
        const selected = yield* fixture.read("read");
        expect(selected).not.toBe("initial");
        yield* native(() => fixture.db.prepare("DROP TRIGGER refuse_cutover").run());
        expect(yield* fixture.read("migrate")).toBe("AwaitingRestore");
        expect(yield* fixture.checkpoint()).toBe("initial");
        yield* native(() =>
          fixture.db
            .prepare("UPDATE erasure_control SET generation=? WHERE kind='published'")
            .bind(selected)
            .run()
        );
        expect(yield* fixture.read("migrate")).toBe("Complete");
        yield* native(() =>
          fixture.db
            .prepare("UPDATE erasure_control SET generation=? WHERE kind='published'")
            .bind(replacement)
            .run()
        );
        expect(yield* fixture.read("migrate")).toBe("AwaitingRestore");
        expect(yield* fixture.checkpoint()).toBe(replacement);
      })
  );

  test.effect("refuses reinitialization after complete native metadata and journal loss", () =>
    Effect.gen(function* () {
      const fixture = yield* platform;
      expect(yield* fixture.read("migrate")).toBe("Complete");
      const checkpoint = yield* fixture.checkpoint();
      yield* fixture.request("lose");
      expect((yield* fixture.request("migrate")).status).toBe(503);
      expect(yield* fixture.checkpoint()).toBe(checkpoint);
      expect(yield* fixture.read("read")).toMatch(/^publishing:/u);
    })
  );

  test.effect("refuses retained R2 cases without changing either generation", () =>
    Effect.gen(function* () {
      const fixture = yield* platform;
      yield* native(() => fixture.bucket.put(`recovery/cases/${replacement}`, "retained"));
      expect((yield* fixture.request("migrate")).status).toBe(503);
      expect(yield* fixture.read("read")).toBe("initial");
      expect(yield* fixture.checkpoint()).toBe("initial");
    })
  );

  test.effect("grants only one D1 transition to competing migrations", () =>
    Effect.gen(function* () {
      const fixture = yield* platform;
      yield* native(() =>
        fixture.db.batch([
          fixture.db.prepare("CREATE TABLE cutover_writes(value INTEGER NOT NULL)"),
          fixture.db.prepare(
            "CREATE TRIGGER count_cutover AFTER UPDATE ON erasure_control BEGIN INSERT INTO cutover_writes(value) VALUES(1); END"
          ),
        ])
      );
      const responses = yield* Effect.all(
        [fixture.request("migrate"), fixture.request("migrate")],
        { concurrency: "unbounded" }
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(yield* fixture.read("migrate")).toBe("Complete");
      expect(
        yield* native(() =>
          fixture.db.prepare("SELECT count(*) AS count FROM cutover_writes").first("count")
        )
      ).toBe(1);
    })
  );

  for (const statement of [
    "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('request','user',0,'Draining')",
    "INSERT INTO erasure_control(kind,generation,cursor,scanned) VALUES('restore','initial','',0)",
    "INSERT INTO erasure_restore_members(generation,request_id,user_id) VALUES('initial','request','user')",
  ]) {
    test.effect(`refuses nonempty native recovery state: ${statement.split("(")[0]}`, () =>
      Effect.gen(function* () {
        const fixture = yield* platform;
        yield* native(() => fixture.db.prepare(statement).run());
        expect((yield* fixture.request("migrate")).status).toBe(503);
        expect(yield* fixture.read("read")).toBe("initial");
        expect(yield* fixture.checkpoint()).toBe("initial");
      })
    );
  }
});
