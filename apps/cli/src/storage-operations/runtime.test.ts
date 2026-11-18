import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, Schema, Terminal } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runStorageOperator } from "./runtime";

const fixtureToken = "fixture.header.signature";
const signedAccess = Effect.fnUntraced(function* (url: string) {
  const platform = yield* ChildProcessSpawner.ChildProcessSpawner;
  return ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") return Effect.die("Unexpected operator pipeline");
    expect(command.command).toBe("cloudflared");
    const login = command.args[1] === "login";
    expect(command.args).toEqual(
      login ? ["access", "login", "--quiet", url] : ["access", "token", "--app", url]
    );
    return platform.spawn(
      ChildProcess.make(
        process.execPath,
        ["-e", login ? "process.exit(0)" : "process.stdout.write('fixture.header.signature')"],
        command.options
      )
    );
  });
});
const native = it.layer(BunServices.layer, { excludeTestServices: true });
for (const action of ["inspect", "Continue"] as const) {
  native((test) =>
    test.effect(
      "uses the dedicated Access application and bounded CLI response for " + action,
      () =>
        Effect.gen(function* () {
          const erasure = action === "Continue";
          const url =
            "https://api.fidyapp.com/internal/" +
            (erasure ? "titular-erasure" : "storage-operations");
          const command = erasure
            ? {
                action,
                userId: "22550000-0000-4000-8000-000000000051",
                reference: "22550000-0000-4000-8000-000000000052",
              }
            : { action, owner: "directory" };
          const spawner = yield* signedAccess(url);
          const current = yield* Terminal.Terminal;
          const terminal = Terminal.make({
            ...current,
            readLine: Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(command).pipe(
              Effect.orDie
            ),
          });
          const messages: string[] = [];
          const http = HttpClient.make((request) => {
            expect(request.url).toBe(url);
            expect(request.headers["cf-access-token"]).toBe(fixtureToken);
            const response = erasure
              ? new Response(null, { status: 202 })
              : Response.json({
                  owner: "directory",
                  release: "22550000-0000-4000-8000-000000000053",
                  readiness: "ready",
                  version: 12,
                  expectedVersion: 12,
                  bytes: 65536,
                  ceilingBytes: 1000000,
                  band: "normal",
                  next: null,
                });
            return Effect.succeed(HttpClientResponse.fromWeb(request, response));
          });
          yield* runStorageOperator(["storage"], {
            interactive: true,
            write: (message) =>
              Effect.sync(() => {
                messages.push(message);
              }),
          }).pipe(
            Effect.provideService(Terminal.Terminal, terminal),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HttpClient.HttpClient, http)
          );
          expect(messages.join("")).toContain(
            erasure ? "Continuation accepted" : '"readiness":"ready"'
          );
          expect(messages.join("")).not.toContain(fixtureToken);
        })
    )
  );
}
