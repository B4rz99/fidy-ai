import { Config, Data, Effect, Option, Redacted, Schema } from "effect";

const productionTraceRateTenPercent = 0.1;
const productionTraceRateFivePercent = 0.05;
const productionTraceRateOnePercent = 0.01;
const completeTraceRate = 1;

/** Deployment role that determines the accepted Sentry project and root sampling policy. */
export type TelemetryEnvironment = "production" | "local" | "ci";

/** Root trace rates approved for production spend and volume. */
export type ProductionTraceRate =
  | typeof productionTraceRateTenPercent
  | typeof productionTraceRateFivePercent
  | typeof productionTraceRateOnePercent;
const fullShaReleasePattern = /^fidy@[0-9a-f]{40}$/u;

/** Immutable Fidy release identifier validated as a full lowercase Git SHA. */
export const TelemetryRelease = Schema.TemplateLiteral(["fidy@", Schema.String]).check(
  Schema.isPattern(fullShaReleasePattern)
);
export type TelemetryRelease = typeof TelemetryRelease.Type;

/** Validated DSN for the project selected by the deployment role. */
export const SentryDsn = Schema.TemplateLiteral(["https://", Schema.String]);
export type SentryDsn = typeof SentryDsn.Type;

/** Public coordinates that distinguish an approved Sentry project without exposing its DSN. */
export const SentryProjectIdentity = Schema.Struct({
  origin: SentryDsn,
  projectId: Schema.TemplateLiteral([Schema.Finite]),
});
export type SentryProjectIdentity = typeof SentryProjectIdentity.Type;

/** Code-owned production and non-production project policy; absent identities reject enablement. */
export type ApprovedSentryProjects = Readonly<{
  production: Option.Option<SentryProjectIdentity>;
  nonProduction: Option.Option<SentryProjectIdentity>;
}>;

/** Non-empty combination of independently enabled error and trace capture. */
export type EnabledCapture =
  | Readonly<{ errors: true; traces: false }>
  | Readonly<{ errors: false; traces: true }>
  | Readonly<{ errors: true; traces: true }>;

/** Telemetry-off state, containing no SDK or transport configuration. */
export type DisabledTelemetryConfig = Readonly<{
  _tag: "Disabled";
  environment: TelemetryEnvironment;
  capture: Readonly<{ errors: false; traces: false }>;
}>;

/** Validated production capture policy with restricted root sampling. */
export type ProductionTelemetryConfig = Readonly<{
  _tag: "ProductionEnabled";
  environment: "production";
  project: "production";
  capture: EnabledCapture;
  dsn: SentryDsn;
  release: TelemetryRelease;
  errorSampleRate: 1;
  rootTraceRate: ProductionTraceRate;
}>;

/** Validated local or CI capture policy with complete root sampling. */
export type NonProductionTelemetryConfig = Readonly<{
  _tag: "NonProductionEnabled";
  environment: "local" | "ci";
  project: "non-production";
  capture: EnabledCapture;
  dsn: SentryDsn;
  release: TelemetryRelease;
  errorSampleRate: 1;
  rootTraceRate: 1;
}>;

/** The only decoded telemetry configuration consumed after process startup. */
export type TelemetryConfig =
  | DisabledTelemetryConfig
  | ProductionTelemetryConfig
  | NonProductionTelemetryConfig;

/** Closed metadata-only reasons an enabled configuration can be rejected. */
export type InvalidTelemetryConfigReason =
  | "crossed_project"
  | "missing_dsn"
  | "malformed_dsn"
  | "missing_release"
  | "malformed_release"
  | "missing_trace_rate"
  | "unsupported_trace_rate";

/** Metadata-only startup failure; raw DSNs and release candidates never enter the error. */
export class InvalidTelemetryConfig extends Data.TaggedError("InvalidTelemetryConfig")<{
  readonly reason: InvalidTelemetryConfigReason;
}> {}

const rawTelemetryConfig = Config.all({
  environment: Config.literals(["production", "local", "ci"], "SENTRY_ENVIRONMENT").pipe(
    Config.withDefault("local")
  ),
  captureErrors: Config.boolean("SENTRY_CAPTURE_ERRORS").pipe(Config.withDefault(false)),
  captureTraces: Config.boolean("SENTRY_CAPTURE_TRACES").pipe(Config.withDefault(false)),
  productionDsn: Config.option(Config.redacted("SENTRY_PRODUCTION_DSN")),
  nonProductionDsn: Config.option(Config.redacted("SENTRY_NON_PRODUCTION_DSN")),
  release: Config.option(Config.string("SENTRY_RELEASE")),
  traceSampleRate: Config.option(Config.finite("SENTRY_TRACE_SAMPLE_RATE")),
});

const sentryProjectPathPattern = /^\/\d+$/u;

const enabledCapture = (errors: boolean, traces: boolean): EnabledCapture => {
  if (errors) return traces ? { errors: true, traces: true } : { errors: true, traces: false };
  return { errors: false, traces: true };
};

const hasValidDsnShape = (url: URL): boolean =>
  url.protocol === "https:" &&
  url.username.length > 0 &&
  url.password.length === 0 &&
  url.search.length === 0 &&
  url.hash.length === 0 &&
  sentryProjectPathPattern.test(url.pathname);

const decodeDsn = (
  candidate: Redacted.Redacted<string>,
  approvedProject: Option.Option<SentryProjectIdentity>
): Effect.Effect<SentryDsn, InvalidTelemetryConfig> => {
  const value = Redacted.value(candidate);
  const decoded = Schema.decodeUnknownOption(Schema.URLFromString)(value);
  if (Option.isNone(decoded)) {
    return Effect.fail(new InvalidTelemetryConfig({ reason: "malformed_dsn" }));
  }
  const url = decoded.value;
  if (!hasValidDsnShape(url)) {
    return Effect.fail(new InvalidTelemetryConfig({ reason: "malformed_dsn" }));
  }
  if (
    Option.isNone(approvedProject) ||
    url.origin !== approvedProject.value.origin ||
    url.pathname !== `/${approvedProject.value.projectId}`
  ) {
    return Effect.fail(new InvalidTelemetryConfig({ reason: "crossed_project" }));
  }
  return Schema.decodeUnknownEffect(SentryDsn)(value).pipe(
    Effect.mapError(() => new InvalidTelemetryConfig({ reason: "malformed_dsn" }))
  );
};

const decodeRelease = (
  candidate: Option.Option<string>
): Effect.Effect<TelemetryRelease, InvalidTelemetryConfig> =>
  Option.match(candidate, {
    onNone: () => Effect.fail(new InvalidTelemetryConfig({ reason: "missing_release" })),
    onSome: (value) =>
      Schema.decodeUnknownEffect(TelemetryRelease)(value).pipe(
        Effect.mapError(() => new InvalidTelemetryConfig({ reason: "malformed_release" }))
      ),
  });

const productionTraceRate = (
  candidate: Option.Option<number>
): Effect.Effect<ProductionTraceRate, InvalidTelemetryConfig> =>
  Option.match(candidate, {
    onNone: () => Effect.fail(new InvalidTelemetryConfig({ reason: "missing_trace_rate" })),
    onSome: (value) =>
      value === productionTraceRateTenPercent ||
      value === productionTraceRateFivePercent ||
      value === productionTraceRateOnePercent
        ? Effect.succeed(value)
        : Effect.fail(new InvalidTelemetryConfig({ reason: "unsupported_trace_rate" })),
  });

const nonProductionTraceRate = (
  candidate: Option.Option<number>
): Effect.Effect<1, InvalidTelemetryConfig> =>
  Option.match(candidate, {
    onNone: () => Effect.succeed(completeTraceRate),
    onSome: (value) =>
      value === completeTraceRate
        ? Effect.succeed(completeTraceRate)
        : Effect.fail(new InvalidTelemetryConfig({ reason: "unsupported_trace_rate" })),
  });

type RawTelemetryConfig = Effect.Success<typeof rawTelemetryConfig>;

const requireDsn = (
  candidate: Option.Option<Redacted.Redacted<string>>,
  approvedProject: Option.Option<SentryProjectIdentity>
): Effect.Effect<SentryDsn, InvalidTelemetryConfig> =>
  Option.match(candidate, {
    onNone: () => Effect.fail(new InvalidTelemetryConfig({ reason: "missing_dsn" })),
    onSome: (dsn) => decodeDsn(dsn, approvedProject),
  });

const decodeEnabled = (
  raw: RawTelemetryConfig,
  approvedProjects: ApprovedSentryProjects
): Effect.Effect<
  ProductionTelemetryConfig | NonProductionTelemetryConfig,
  InvalidTelemetryConfig
> =>
  Effect.gen(function* () {
    const capture = enabledCapture(raw.captureErrors, raw.captureTraces);
    const release = yield* decodeRelease(raw.release);
    if (raw.environment === "production") {
      if (Option.isSome(raw.nonProductionDsn)) {
        return yield* new InvalidTelemetryConfig({ reason: "crossed_project" });
      }
      const dsn = yield* requireDsn(raw.productionDsn, approvedProjects.production);
      const rootTraceRate = yield* productionTraceRate(raw.traceSampleRate);
      return {
        _tag: "ProductionEnabled",
        environment: "production",
        project: "production",
        capture,
        dsn,
        release,
        errorSampleRate: 1,
        rootTraceRate,
      };
    }
    if (Option.isSome(raw.productionDsn)) {
      return yield* new InvalidTelemetryConfig({ reason: "crossed_project" });
    }
    const dsn = yield* requireDsn(raw.nonProductionDsn, approvedProjects.nonProduction);
    const rootTraceRate = yield* nonProductionTraceRate(raw.traceSampleRate);
    return {
      _tag: "NonProductionEnabled",
      environment: raw.environment,
      project: "non-production",
      capture,
      dsn,
      release,
      errorSampleRate: 1,
      rootTraceRate,
    };
  });

/**
 * Decodes process configuration against the supplied project policy. Disabled capture needs no
 * project identity; enabled capture fails with metadata-only configuration errors before SDK use.
 */
export const telemetryConfigForProjects = (
  approvedProjects: ApprovedSentryProjects
): Effect.Effect<TelemetryConfig, Config.ConfigError | InvalidTelemetryConfig> =>
  Effect.flatMap(
    rawTelemetryConfig,
    (raw): Effect.Effect<TelemetryConfig, InvalidTelemetryConfig> =>
      raw.captureErrors || raw.captureTraces
        ? decodeEnabled(raw, approvedProjects)
        : Effect.succeed({
            _tag: "Disabled",
            environment: raw.environment,
            capture: { errors: false, traces: false },
          })
  );

/** Validates the explicit non-production identity used only by the bounded operator smoke command. */
export const decodeSentryAccountSmokeConfig = (input: {
  readonly dsn: Redacted.Redacted<string>;
  readonly release: string;
  readonly environment: "local" | "ci";
}): Effect.Effect<NonProductionTelemetryConfig, InvalidTelemetryConfig> =>
  Effect.gen(function* () {
    const candidate = Schema.decodeUnknownOption(Schema.URLFromString)(Redacted.value(input.dsn));
    if (Option.isNone(candidate) || !hasValidDsnShape(candidate.value)) {
      return yield* new InvalidTelemetryConfig({ reason: "malformed_dsn" });
    }
    const identity = Schema.decodeUnknownOption(SentryProjectIdentity)({
      origin: candidate.value.origin,
      projectId: candidate.value.pathname.slice(1),
    });
    if (Option.isNone(identity)) {
      return yield* new InvalidTelemetryConfig({ reason: "malformed_dsn" });
    }
    const dsn = yield* decodeDsn(input.dsn, identity);
    const release = yield* decodeRelease(Option.some(input.release));
    return {
      _tag: "NonProductionEnabled",
      environment: input.environment,
      project: "non-production",
      capture: { errors: true, traces: true },
      dsn,
      release,
      errorSampleRate: 1,
      rootTraceRate: 1,
    };
  });

/**
 * Reads raw Sentry variables once. Enabled capture remains fail-closed until provisioned project
 * coordinates replace this empty checked-in policy.
 */
export const telemetryConfig = telemetryConfigForProjects({
  production: Option.none(),
  nonProduction: Option.none(),
});
