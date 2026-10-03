import type { APIRequestContext, Page } from "@playwright/test";
import { BunFileSystem } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { signInThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
class CliJourneyFailed extends Data.TaggedError("CliJourneyFailed") {}
const wait = <A>(promise: Promise<A>): Effect.Effect<A, CliJourneyFailed> =>
  Effect.tryPromise({ try: () => promise, catch: () => new CliJourneyFailed() });
const entry = new URL("../../cli/test/journey-entry.ts", import.meta.url).pathname;
const Approval = Schema.fromJsonString(
  Schema.TaggedStruct("ApprovalRequired", {
    publicCode: Schema.String,
    managementUrl: Schema.Literal("https://fidyapp.com/settings/pats"),
  })
);
const maximumOutputBytes = 16_384;

const firstOutput = Effect.fn(function* (reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = yield* wait(reader.read());
  if (chunk.done || chunk.value.byteLength > maximumOutputBytes) {
    return yield* new CliJourneyFailed();
  }
  return yield* Schema.decodeEffect(Approval)(new TextDecoder().decode(chunk.value).trim());
});
const finished = Effect.fn(function* (
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  reader: ReadableStreamDefaultReader<Uint8Array> = child.stdout.getReader()
) {
  let output = "";
  let chunk = yield* wait(reader.read());
  while (!chunk.done) {
    if (output.length + chunk.value.byteLength > maximumOutputBytes) {
      return yield* new CliJourneyFailed();
    }
    output += new TextDecoder().decode(chunk.value);
    chunk = yield* wait(reader.read());
  }
  reader.releaseLock();
  const exitCode = yield* wait(child.exited);
  expect(exitCode).toBe(0);
  expect(output.includes("fin_")).toBe(false);
  return output;
});

const cliJourney = Effect.fn(function* ({
  page,
  request,
}: Readonly<{ page: Page; request: APIRequestContext }>) {
  yield* wait(signInThroughCore({ page, request }));
  const filesystem = yield* FileSystem.FileSystem;
  const directory = yield* filesystem.makeTempDirectoryScoped();
  const service = `com.fidy.cli.journey.${process.pid}-${Bun.nanoseconds()}`;
  const spawn = (args: ReadonlyArray<string>): Bun.Subprocess<"ignore", "pipe", "pipe"> =>
    Bun.spawn([process.execPath, entry, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: Bun.env.PATH,
        HOME: Bun.env.HOME,
        USERPROFILE: Bun.env.USERPROFILE,
        SYSTEMROOT: Bun.env.SYSTEMROOT,
        DBUS_SESSION_BUS_ADDRESS: Bun.env.DBUS_SESSION_BUS_ADDRESS,
        XDG_RUNTIME_DIR: Bun.env.XDG_RUNTIME_DIR,
        CLI_ACCEPTANCE_MODE: Bun.env.CLI_ACCEPTANCE_MODE,
        CLI_JOURNEY_DIRECTORY: directory,
        CLI_JOURNEY_SERVICE: service,
      },
    });
  yield* Effect.acquireUseRelease(
    Effect.sync(() =>
      spawn(["login", "--recipient", "CLI de prueba", "--scopes", "read", "--lifetime", "7"])
    ),
    (child) =>
      Effect.gen(function* () {
        const reader = child.stdout.getReader();
        const approval = yield* firstOutput(reader);
        yield* wait(page.goto("/settings/pats"));
        yield* wait(page.getByLabel("Código", { exact: true }).fill(approval.publicCode));
        yield* wait(page.getByRole("button", { name: "Continuar" }).click());
        yield* wait(expect(page.getByText("CLI de prueba").first()).toBeVisible());
        yield* wait(page.getByRole("button", { name: "Autorizar acceso" }).click());
        yield* wait(expect(page.getByText("Acceso autorizado")).toBeVisible());
        const success = yield* finished(child, reader);
        expect(success).toContain("LoggedIn");
        const status = yield* finished(spawn(["status"]));
        expect(status).toContain('"availability":"available"');
        expect(status).toContain('"scopes":["read"]');
        expect(status).toContain('"lifetimeDays":7');
        yield* finished(spawn(["reuse"]));
      }),
    (child) =>
      Effect.sync(() => {
        child.kill();
      }).pipe(
        Effect.andThen(wait(child.exited)),
        Effect.andThen(() => wait(spawn(["logout"]).exited)),
        Effect.andThen(() => wait(spawn(["cleanup"]).exited)),
        Effect.asVoid
      )
  );
});

test("CLI login claims a web-approved grant and a second process reuses native saved access", ({
  page,
  request,
}) =>
  Effect.runPromise(
    cliJourney({ page, request }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer))
  ));
