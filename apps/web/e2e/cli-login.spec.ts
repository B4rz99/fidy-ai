import type { APIRequestContext, Page } from "@playwright/test";
import { BunFileSystem } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Option, Predicate, Record, Schema } from "effect";
import { PublicOutput } from "../../cli/src/command/contract";
import {
  type ProcessUnavailable,
  type TestProcess,
  scopedProcess,
} from "../../cli/test/process.test-fixture";
import { playwright } from "./playwright-runtime";
import { signInThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
class CliJourneyFailed extends Data.TaggedError("CliJourneyFailed") {}
const wait = <A>(promise: Promise<A>): Effect.Effect<A, CliJourneyFailed> =>
  Effect.tryPromise({ try: () => promise, catch: () => new CliJourneyFailed() });
const entry = Bun.fileURLToPath(new URL("../../cli/test/journey-entry.ts", import.meta.url));
const outputCodec = Schema.fromJsonString(Schema.toCodecJson(PublicOutput));
const maximumOutputBytes = 16_384;

const firstOutput = Effect.fn(function* (child: TestProcess) {
  const chunk = yield* child.read;
  if (Option.isNone(chunk) || chunk.value.byteLength > maximumOutputBytes) {
    return yield* new CliJourneyFailed();
  }
  const output = yield* Schema.decodeEffect(outputCodec, { onExcessProperty: "error" })(
    new TextDecoder().decode(chunk.value).trim()
  );
  if (output._tag !== "ApprovalRequired") {
    return yield* new CliJourneyFailed();
  }
  return output;
});
const finished = Effect.fn(function* (child: TestProcess) {
  let output = "";
  let bytes = 0;
  let chunk = yield* child.read;
  while (Option.isSome(chunk)) {
    bytes += chunk.value.byteLength;
    if (bytes > maximumOutputBytes) {
      return yield* new CliJourneyFailed();
    }
    output += new TextDecoder().decode(chunk.value);
    chunk = yield* child.read;
  }
  expect(yield* child.exited).toBe(0);
  expect(output.includes("fin_")).toBe(false);
  return output;
});

const journeyEnvironment = (directory: string, service: string): Readonly<Record<string, string>> =>
  Record.filter(
    {
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
    Predicate.isString
  );

const cliJourney = Effect.fn(function* ({
  page,
  request,
}: Readonly<{ page: Page; request: APIRequestContext }>) {
  yield* wait(signInThroughCore({ page, request }));
  const filesystem = yield* FileSystem.FileSystem;
  const directory = yield* filesystem.makeTempDirectoryScoped();
  const service = `com.fidy.cli.journey.${process.pid}-${Bun.nanoseconds()}`;
  const env = journeyEnvironment(directory, service);
  const spawn = (args: ReadonlyArray<string>): ReturnType<typeof scopedProcess> =>
    scopedProcess([process.execPath, entry, ...args], env);
  const complete = (
    args: ReadonlyArray<string>
  ): Effect.Effect<string, CliJourneyFailed | ProcessUnavailable> =>
    Effect.gen(function* () {
      return yield* finished(yield* spawn(args));
    }).pipe(Effect.scoped);
  // Registered before children: their kill-and-await finalizers run before native cleanup.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const logout = yield* spawn(["logout"]);
      yield* logout.exited;
      const cleanup = yield* spawn(["cleanup"]);
      expect(yield* cleanup.exited).toBe(0);
    }).pipe(Effect.scoped, Effect.orDie)
  );
  const child = yield* spawn([
    "login",
    "--recipient",
    "CLI de prueba",
    "--scopes",
    "read",
    "--lifetime",
    "7",
  ]);
  const approval = yield* firstOutput(child);
  yield* wait(page.goto("/settings/pats"));
  yield* wait(page.getByLabel("Código", { exact: true }).fill(approval.publicCode));
  yield* wait(page.getByRole("button", { name: "Continuar" }).click());
  yield* wait(expect(page.getByText("CLI de prueba").first()).toBeVisible());
  yield* wait(page.getByRole("button", { name: "Autorizar acceso" }).click());
  yield* wait(expect(page.getByText("Acceso autorizado")).toBeVisible());
  expect(yield* finished(child)).toContain("LoggedIn");
  const status = yield* complete(["status"]);
  expect(status).toContain('"availability":"available"');
  expect(status).toContain('"scopes":["read"]');
  expect(status).toContain('"lifetimeDays":7');
  const categories = yield* complete(["categories", "listCategories"]);
  expect(categories).toContain('"label":"Restaurantes"');
  const historyInput = `${directory}/history.json`;
  yield* filesystem.writeFileString(historyInput, '{"query":{"currency":"COP"}}');
  const transactions = yield* complete([
    "transactions",
    "listTransactions",
    "--input",
    historyInput,
  ]);
  expect(transactions).toContain('"data":');
  expect(transactions).toContain('"next":');
});

test("CLI login claims a web-approved grant and a second process reuses native saved access", ({
  page,
  request,
}) =>
  Effect.runPromise(
    cliJourney({ page, request }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer))
  ));
