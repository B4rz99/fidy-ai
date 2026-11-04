import { getPlatformProxy } from "wrangler";
import { Config, Effect, FileSystem, Option, Path, Schema, type Scope } from "effect";
import {
  type ProGrantEntry,
  ProGrantFailure,
} from "../../apps/server/src/shell/pro-grants/contract";
import {
  type ProGrantOperatorBinding,
  ProGrantOperatorReply,
  ProGrantOperatorRequest,
} from "../../apps/server/cloudflare/pro-grants/contract";

const WorkerName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,63}$/u));
const Configuration = Schema.Struct({
  accountId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  coreWorkerName: WorkerName,
});
const ProxyConfiguration = Schema.Struct({
  name: Schema.Literal("fidy-pro-operator"),
  account_id: Configuration.fields.accountId,
  compatibility_date: Schema.Literal("2026-09-08"),
  send_metrics: Schema.Literal(false),
  services: Schema.Tuple([
    Schema.Struct({
      binding: Schema.Literal("PRO_COMMANDS"),
      service: WorkerName,
      entrypoint: Schema.Literal("ProGrantService"),
      remote: Schema.Literal(true),
    }),
  ]),
});
const unavailable = (): ProGrantFailure =>
  new ProGrantFailure({ reason: "unavailable", candidates: [] });
const io = <A>(work: () => Promise<A>): Effect.Effect<A, ProGrantFailure> =>
  Effect.tryPromise({ try: work, catch: unavailable });
const fixedProviderOrigin = Config.all([
  Config.option(Config.String("CLOUDFLARE_API_BASE_URL")),
  Config.option(Config.String("CF_API_BASE_URL")),
  Config.option(Config.String("CLOUDFLARE_BASE_URL")),
]).pipe(
  Effect.map((values) =>
    values.every(
      (value) => Option.isNone(value) || value.value === "https://api.cloudflare.com/client/v4"
    )
  ),
  Effect.mapError(unavailable)
);
const configurationFile = (
  config: typeof Configuration.Type
): Effect.Effect<string, ProGrantFailure, Scope.Scope | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs
      .makeTempDirectoryScoped({ prefix: "fidy-pro-operator-" })
      .pipe(Effect.mapError(unavailable));
    const file = path.join(directory, "wrangler.json");
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ProxyConfiguration))({
      name: "fidy-pro-operator",
      account_id: config.accountId,
      compatibility_date: "2026-09-08",
      send_metrics: false,
      services: [
        {
          binding: "PRO_COMMANDS",
          service: config.coreWorkerName,
          entrypoint: "ProGrantService",
          remote: true,
        },
      ],
    }).pipe(Effect.mapError(unavailable));
    yield* fs.writeFileString(file, encoded, { mode: 0o600 }).pipe(Effect.mapError(unavailable));
    return file;
  });
/** Existing account administrator credentials open one private named binding. No database UUID or SQL crosses this client interface. */
export const runProOperatorCommand = (
  input: Readonly<{
    accountId: string;
    coreWorkerName: string;
    legacyDatabaseId: Option.Option<string>;
    command: unknown;
    operator: string;
  }>
): Effect.Effect<
  ReadonlyArray<typeof ProGrantEntry.Type>,
  ProGrantFailure,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const providerOriginAllowed = yield* fixedProviderOrigin;
    if (Option.isSome(input.legacyDatabaseId) || !providerOriginAllowed) {
      return yield* unavailable();
    }
    const request = yield* Schema.decodeUnknownEffect(ProGrantOperatorRequest, {
      onExcessProperty: "error",
    })({ command: input.command, operator: input.operator }).pipe(
      Effect.mapError(() => new ProGrantFailure({ reason: "invalid-input", candidates: [] }))
    );
    const config = yield* Schema.decodeEffect(Configuration)(input).pipe(
      Effect.mapError(unavailable)
    );
    const configPath = yield* configurationFile(config);
    const proxy = yield* Effect.acquireRelease(
      io(() =>
        getPlatformProxy<{ PRO_COMMANDS: ProGrantOperatorBinding }>({
          configPath,
          remoteBindings: true,
          persist: false,
          envFiles: [],
        })
      ),
      (proxy) => io(() => proxy.dispose()).pipe(Effect.orDie)
    );
    const reply = yield* io(() => Promise.resolve(proxy.env.PRO_COMMANDS.execute(request))).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(unavailable),
      Effect.flatMap(Schema.decodeUnknownEffect(ProGrantOperatorReply)),
      Effect.mapError(unavailable)
    );
    if (reply.kind === "refused") {
      return yield* new ProGrantFailure({ reason: reply.reason, candidates: reply.candidates });
    }
    return reply.entries;
  }).pipe(Effect.scoped);
