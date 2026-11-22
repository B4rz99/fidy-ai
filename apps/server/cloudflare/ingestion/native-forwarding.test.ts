import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { native, nativeUserPlatform } from "../user-store.test-fixture";
import { alice, seed } from "../financial-user-store.test-fixture";
import { browserOrigins, productionTopology } from "../runtime/contract";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "discloses the same consent-bound forwarding address only after exact directory registration",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeUserPlatform;
        const runtime = yield* create();
        const owner = yield* seed(runtime, alice);
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES ('grant',?,'processing_grant',?)",
          alice.user,
          owner.now
        );

        const read = (): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
          native(() =>
            runtime.dispatchFetch(
              `https://${productionTopology.ingress.hostname}/ingestion/email-forwarding`,
              {
                headers: {
                  origin: browserOrigins.production,
                  "Fidy-Session-Binding": alice.session,
                  cookie: `__Host-fidy_session=${alice.bearer}`,
                },
              }
            )
          );

        const response = yield* read();
        expect(response.status).toBe(200);
        const first = yield* native(() => response.json());

        const disclosed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({ address: Schema.Struct({ address: Schema.String }) }),
          })
        )(first);

        expect(disclosed.data.address.address).toMatch(/^[a-z0-9_-]{24,64}@fidyapp\.com$/u);
        yield* native(() =>
          owner.directory.exec("ALTER TABLE external_event_routes RENAME TO offline")
        );
        const unavailable = yield* read();
        expect(unavailable.status).toBe(503);
        expect(yield* native(() => unavailable.text())).not.toContain("@fidyapp.com");
        yield* native(() =>
          owner.directory.exec("ALTER TABLE offline RENAME TO external_event_routes")
        );
        const again = yield* read();
        expect(yield* native(() => again.json())).toEqual(first);
      })
  );
});
