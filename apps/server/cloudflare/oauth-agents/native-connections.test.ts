import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { native, nativeConnectionPlatform } from "../user-store.test-fixture";
import { nativeGrantWithScopes, protocolFor } from "./native-grant.test-fixture";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("uses the live OAuth grant for Connection discovery, start and exact retry", () =>
    Effect.gen(function* () {
      const { runtime, owner, credential, connectionId } = yield* nativeGrantWithScopes(
        ["read", "write"],
        nativeConnectionPlatform
      );

      const protocol = protocolFor(runtime);

      const start = {
        name: "connections.connectInstitution",
        args: { payload: { institutionId: "bancolombia" } },
        retryKey: "one-connection",
      };

      const first = yield* protocol(credential.access_token, "tools/call", start);
      const output = yield* native(() => first.json());
      expect(output).toMatchObject({ result: { isError: false } });
      const repeated = yield* protocol(credential.access_token, "tools/call", start);
      expect(yield* native(() => repeated.json())).toEqual(output);

      const list = yield* protocol(credential.access_token, "tools/call", {
        name: "connections.listConnections",
        args: {},
      });

      expect(yield* native(() => list.text())).toContain("Connecting");
      expect(yield* owner.exec("SELECT count(*) AS n FROM connection_attempts")).toEqual([
        { n: 1 },
      ]);
      expect(
        yield* owner.exec(
          "SELECT count(*) AS n FROM audit_entries WHERE operation='connections.connectInstitution' AND oauth_connection_id=? AND outcome='accepted'",
          connectionId
        )
      ).toEqual([{ n: 2 }]);
      expect(
        yield* owner.exec(
          "SELECT count(*) AS n FROM canonical_request_receipts WHERE operation='connections.connectInstitution'"
        )
      ).toEqual([{ n: 1 }]);
      yield* owner.exec(
        "UPDATE oauth_connections SET scopes_json=? WHERE id=?",
        '["read"]',
        connectionId
      );
      const denied = yield* protocol(credential.access_token, "tools/call", start);
      expect(denied.status).toBe(401);
      yield* native(() => denied.text());
    })
  );
});
