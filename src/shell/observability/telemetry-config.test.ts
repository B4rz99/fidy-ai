import { expect, it } from "@effect/vitest";
import { type Config, ConfigProvider, Effect, Exit, Function as Fn, Option } from "effect";
import {
  type ApprovedSentryProjects,
  InvalidTelemetryConfig,
  type TelemetryConfig,
  telemetryConfigForProjects,
} from "./telemetry-config";

const fullSha = "0123456789abcdef0123456789abcdef01234567";
const release = `fidy@${fullSha}`;
const productionDsn = "https://production-public@o1.ingest.sentry.io/100";
const nonProductionDsn = "https://non-production-public@o1.ingest.sentry.io/200";
const approvedProjects = {
  production: Option.some({ origin: "https://o1.ingest.sentry.io", projectId: "100" }),
  nonProduction: Option.some({ origin: "https://o1.ingest.sentry.io", projectId: "200" }),
} satisfies ApprovedSentryProjects;

type Input = Readonly<Record<string, string>>;

const load = (
  input: Input
): Effect.Effect<TelemetryConfig, Config.ConfigError | InvalidTelemetryConfig> =>
  telemetryConfigForProjects(approvedProjects).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(input))
  );

const enabledInput = (input: Input): Input => ({
  SENTRY_CAPTURE_ERRORS: "true",
  SENTRY_RELEASE: release,
  ...input,
});

it.effect.each([
  { environment: undefined, expectedEnvironment: "local" as const },
  { environment: "local", expectedEnvironment: "local" as const },
  { environment: "ci", expectedEnvironment: "ci" as const },
  { environment: "production", expectedEnvironment: "production" as const },
])(
  "decodes disabled $expectedEnvironment configuration without enabled fields",
  ({ environment, expectedEnvironment }) =>
    Effect.gen(function* () {
      const config = yield* load(
        environment === undefined ? {} : { SENTRY_ENVIRONMENT: environment }
      );

      expect(config).toEqual({
        _tag: "Disabled",
        environment: expectedEnvironment,
        capture: { errors: false, traces: false },
      });
    })
);

it.effect.each([
  { errors: true, traces: false },
  { errors: false, traces: true },
  { errors: true, traces: true },
])("decodes independent production switches $errors/$traces", ({ errors, traces }) =>
  Effect.gen(function* () {
    const config = yield* load({
      SENTRY_ENVIRONMENT: "production",
      SENTRY_CAPTURE_ERRORS: String(errors),
      SENTRY_CAPTURE_TRACES: String(traces),
      SENTRY_PRODUCTION_DSN: productionDsn,
      SENTRY_RELEASE: release,
      SENTRY_TRACE_SAMPLE_RATE: "0.1",
    });

    expect(config).toMatchObject({
      _tag: "ProductionEnabled",
      environment: "production",
      capture: { errors, traces },
      dsn: productionDsn,
      release,
      errorSampleRate: 1,
      rootTraceRate: 0.1,
    });
  })
);

it.effect.each([
  { environment: "local" as const, errors: true, traces: false },
  { environment: "local" as const, errors: false, traces: true },
  { environment: "local" as const, errors: true, traces: true },
  { environment: "ci" as const, errors: true, traces: false },
  { environment: "ci" as const, errors: false, traces: true },
  { environment: "ci" as const, errors: true, traces: true },
])("decodes $environment switches $errors/$traces at 100%", ({ environment, errors, traces }) =>
  Effect.gen(function* () {
    const config = yield* load({
      SENTRY_ENVIRONMENT: environment,
      SENTRY_CAPTURE_ERRORS: String(errors),
      SENTRY_CAPTURE_TRACES: String(traces),
      SENTRY_NON_PRODUCTION_DSN: nonProductionDsn,
      SENTRY_RELEASE: release,
    });

    expect(config).toMatchObject({
      _tag: "NonProductionEnabled",
      environment,
      capture: { errors, traces },
      dsn: nonProductionDsn,
      release,
      errorSampleRate: 1,
      rootTraceRate: 1,
    });
  })
);

it.effect(
  "keeps enabled capture closed while deployment project identities are unprovisioned",
  () =>
    Effect.gen(function* () {
      const exit = yield* telemetryConfigForProjects({
        production: Option.none(),
        nonProduction: Option.none(),
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(enabledInput({ SENTRY_NON_PRODUCTION_DSN: nonProductionDsn }))
        ),
        Effect.exit
      );

      expect(Exit.findErrorOption(exit)).toEqual(
        Option.some(new InvalidTelemetryConfig({ reason: "crossed_project" }))
      );
    })
);

it.effect.each([0.1, 0.05, 0.01])("accepts the approved production root rate $", (rootTraceRate) =>
  Effect.gen(function* () {
    const config = yield* load(
      enabledInput({
        SENTRY_ENVIRONMENT: "production",
        SENTRY_PRODUCTION_DSN: productionDsn,
        SENTRY_TRACE_SAMPLE_RATE: String(rootTraceRate),
      })
    );

    expect(config).toMatchObject({ _tag: "ProductionEnabled", rootTraceRate });
  })
);

const invalidCaseSources = [
  {
    name: "unsupported environment",
    input: { SENTRY_ENVIRONMENT: "development" },
    reason: undefined,
  },
  {
    name: "malformed error switch",
    input: { SENTRY_CAPTURE_ERRORS: "sometimes" },
    reason: undefined,
  },
  {
    name: "malformed trace switch",
    input: { SENTRY_CAPTURE_TRACES: "sometimes" },
    reason: undefined,
  },
  {
    name: "production with only the crossed non-production DSN",
    input: enabledInput({
      SENTRY_ENVIRONMENT: "production",
      SENTRY_NON_PRODUCTION_DSN: nonProductionDsn,
      SENTRY_TRACE_SAMPLE_RATE: "0.1",
    }),
    reason: "crossed_project",
  },
  {
    name: "local with only the crossed production DSN",
    input: enabledInput({ SENTRY_PRODUCTION_DSN: productionDsn }),
    reason: "crossed_project",
  },
  {
    name: "production variable containing the non-production project",
    input: enabledInput({
      SENTRY_ENVIRONMENT: "production",
      SENTRY_PRODUCTION_DSN: nonProductionDsn,
      SENTRY_TRACE_SAMPLE_RATE: "0.1",
    }),
    reason: "crossed_project",
  },
  {
    name: "local variable containing the production project",
    input: enabledInput({ SENTRY_NON_PRODUCTION_DSN: productionDsn }),
    reason: "crossed_project",
  },
  {
    name: "local variable containing an arbitrary valid project host",
    input: enabledInput({
      SENTRY_NON_PRODUCTION_DSN: "https://public@attacker.example/200",
    }),
    reason: "crossed_project",
  },
  {
    name: "local variable containing an arbitrary valid project id",
    input: enabledInput({
      SENTRY_NON_PRODUCTION_DSN: "https://public@o1.ingest.sentry.io/999",
    }),
    reason: "crossed_project",
  },
  {
    name: "production with both project DSNs",
    input: enabledInput({
      SENTRY_ENVIRONMENT: "production",
      SENTRY_PRODUCTION_DSN: productionDsn,
      SENTRY_NON_PRODUCTION_DSN: nonProductionDsn,
      SENTRY_TRACE_SAMPLE_RATE: "0.1",
    }),
    reason: "crossed_project",
  },
  {
    name: "local with both project DSNs",
    input: enabledInput({
      SENTRY_PRODUCTION_DSN: productionDsn,
      SENTRY_NON_PRODUCTION_DSN: nonProductionDsn,
    }),
    reason: "crossed_project",
  },
  {
    name: "enabled production without a DSN",
    input: enabledInput({
      SENTRY_ENVIRONMENT: "production",
      SENTRY_TRACE_SAMPLE_RATE: "0.1",
    }),
    reason: "missing_dsn",
  },
  {
    name: "enabled local without a DSN",
    input: enabledInput({}),
    reason: "missing_dsn",
  },
  {
    name: "enabled production without a release",
    input: {
      SENTRY_ENVIRONMENT: "production",
      SENTRY_CAPTURE_TRACES: "true",
      SENTRY_PRODUCTION_DSN: productionDsn,
      SENTRY_TRACE_SAMPLE_RATE: "0.1",
    },
    reason: "missing_release",
  },
  {
    name: "enabled production without a root rate",
    input: enabledInput({
      SENTRY_ENVIRONMENT: "production",
      SENTRY_PRODUCTION_DSN: productionDsn,
    }),
    reason: "missing_trace_rate",
  },
  {
    name: "local with a non-100% root rate",
    input: enabledInput({
      SENTRY_NON_PRODUCTION_DSN: nonProductionDsn,
      SENTRY_TRACE_SAMPLE_RATE: "0.1",
    }),
    reason: "unsupported_trace_rate",
  },
  ...["0", "0.001", "0.5", "1"].map((rate) => ({
    name: `production with unsupported root rate ${rate}`,
    input: enabledInput({
      SENTRY_ENVIRONMENT: "production",
      SENTRY_PRODUCTION_DSN: productionDsn,
      SENTRY_TRACE_SAMPLE_RATE: rate,
    }),
    reason: "unsupported_trace_rate",
  })),
  ...[
    "fidy@local",
    "fidy@0123456789abcdef0123456789abcdef0123456",
    "fidy@0123456789abcdef0123456789abcdef012345678",
    "other@0123456789abcdef0123456789abcdef01234567",
  ].map((candidate) => ({
    name: `malformed release ${candidate}`,
    input: {
      SENTRY_CAPTURE_ERRORS: "true",
      SENTRY_NON_PRODUCTION_DSN: nonProductionDsn,
      SENTRY_RELEASE: candidate,
    },
    reason: "malformed_release",
  })),
  ...[
    "not-a-url",
    "http://public@o1.ingest.sentry.io/200",
    "https://o1.ingest.sentry.io/200",
    "https://public@o1.ingest.sentry.io/not-a-project",
    "https://public:secret@o1.ingest.sentry.io/200",
  ].map((candidate) => ({
    name: `malformed DSN ${candidate}`,
    input: enabledInput({ SENTRY_NON_PRODUCTION_DSN: candidate }),
    reason: "malformed_dsn",
  })),
];

const invalidCases = invalidCaseSources.map(({ reason, ...testCase }) => ({
  ...testCase,
  reason: Option.fromUndefinedOr(reason),
}));

it.effect.each(invalidCases)("rejects $name before initialization", ({ input, reason }) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(load(Fn.cast<typeof input, Input>(input)));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Option.isSome(reason) && Exit.isFailure(exit)) {
      const error = Option.getOrUndefined(Exit.findErrorOption(exit));
      expect(error).toBeInstanceOf(InvalidTelemetryConfig);
      expect(error).toMatchObject({ reason: reason.value });
    }
  })
);
