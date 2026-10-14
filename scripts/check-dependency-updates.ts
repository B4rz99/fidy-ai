#!/usr/bin/env bun

import {
  Array as Arr,
  Cause,
  Console,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, type HttpClientResponse } from "effect/http";

/** Infrastructure failure of the check, distinct from a dependency-policy finding. */
class CheckFailed extends Data.TaggedError("CheckFailed")<{ readonly message: string }> {}

const REPO_ROOT = Bun.fileURLToPath(new URL("..", import.meta.url));

const REGISTRY_URL = "https://registry.npmjs.org";

const RELEASE_DELAY_SECONDS = 604_800;

const SECONDS_PER_DAY = 86_400;

const MANIFEST_PATTERNS = ["package.json", "*/package.json", "*/*/package.json"];

const POLICY_PATH = "dependency-policy.json";

const SCA_CONFIG_PATH = ".fluidattacks/sca.yaml";

const REGISTRY_CONCURRENCY = 8;
// The response budget applies to decoded bytes, including historical npm release metadata.
const maximumPackumentBytes = 67_108_864;
const rateLimitedStatus = 429;
const serverErrorMinimumStatus = 500;

const EXACT_PIN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
/** SheetJS CE publishes fixed-version tarballs after the stale npm release. */
const EXACT_SHEETJS_CDN_PIN =
  /^https:\/\/cdn\.sheetjs\.com\/xlsx-(\d+)\.(\d+)\.(\d+)\/xlsx-\1\.\2\.\3\.tgz$/;

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

type Version = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** True for `4.0.0-beta.98`. A prerelease is behind its own stable release even though the three numbers match. */
  readonly prerelease: boolean;
  readonly raw: string;
};

type Pin = {
  readonly name: string;
  /** Manifest path relative to the repo root, so failures name a file a reader can open. */
  readonly manifest: string;
  readonly spec: string;
};

type ExactPin = Pin & { readonly current: Version };

/** The size of the step from a pin to the newest release it could take. `stable` is the prerelease-to-release step, where the three numbers do not move at all. */
type Step = "major" | "minor" | "patch" | "stable";

type Severity = "failure" | "warning";

type Finding = {
  readonly severity: Severity;
  readonly subject: string;
  readonly detail: string;
};

const parsePin = (spec: string): Option.Option<Version> => {
  const match = EXACT_PIN.exec(spec) ?? EXACT_SHEETJS_CDN_PIN.exec(spec);

  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return Option.none();
  }

  return Option.some({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
    raw: spec,
  });
};

const stepIfAhead = (kind: Step, current: number, latest: number): Option.Option<Step> =>
  latest > current ? Option.some(kind) : Option.none();

const step = (current: Version, latest: Version): Option.Option<Step> => {
  if (latest.major !== current.major) {
    return stepIfAhead("major", current.major, latest.major);
  }

  if (latest.minor !== current.minor) {
    return stepIfAhead("minor", current.minor, latest.minor);
  }

  if (latest.patch !== current.patch) {
    return stepIfAhead("patch", current.patch, latest.patch);
  }

  return current.prerelease && !latest.prerelease ? Option.some("stable") : Option.none();
};

const severityOf = (kind: Step): Severity => (kind === "major" ? "warning" : "failure");

/** Publish times and the latest npm release tag; releases above latest are excluded. */
const Packument = Schema.Struct({
  "dist-tags": Schema.Struct({ latest: Schema.String }),
  time: Schema.Record(Schema.String, Schema.DateTimeUtcFromString),
});

type Release = {
  readonly version: Version;
  readonly publishedAt: DateTime.Utc;
};

/** Newest installable stable release at or below the latest tag; None when no release qualifies. */
const newestInstallable = (
  packument: typeof Packument.Type,
  startedAt: DateTime.Utc
): Option.Option<Release> => {
  const cutoff = DateTime.subtract(startedAt, { seconds: RELEASE_DELAY_SECONDS });
  const tagged = parsePin(packument["dist-tags"].latest);

  return Object.entries(packument.time)
    .flatMap(([raw, publishedAt]): ReadonlyArray<Release> => {
      const version = STABLE_VERSION.test(raw) ? parsePin(raw) : Option.none<Version>();

      if (Option.isNone(version) || !DateTime.isLessThanOrEqualTo(publishedAt, cutoff)) {
        return [];
      }

      const published =
        Option.isNone(tagged) ||
        Option.isSome(step(version.value, tagged.value)) ||
        version.value.raw === tagged.value.raw;

      return published ? [{ version: version.value, publishedAt }] : [];
    })
    .reduce<Option.Option<Release>>(
      (newest, release) =>
        Option.isNone(newest) || Option.isSome(step(newest.value.version, release.version))
          ? Option.some(release)
          : newest,
      Option.none()
    );
};

const readPackument = Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
  if (Number(response.headers["content-length"] ?? 0) > maximumPackumentBytes) {
    return yield* new CheckFailed({ message: "Registry response exceeded its byte budget" });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* Stream.runForEachWhile(response.stream, (chunk) =>
    Effect.sync(() => {
      size += chunk.byteLength;
      if (size > maximumPackumentBytes) return false;
      chunks.push(chunk);
      return true;
    })
  );
  if (size > maximumPackumentBytes) {
    return yield* new CheckFailed({ message: "Registry response exceeded its byte budget" });
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => new CheckFailed({ message: "Registry response contained invalid text" }),
  });
  return yield* Schema.decodeEffect(Schema.fromJsonString(Packument))(text);
});

const fetchPackument = (
  name: string
): Effect.Effect<typeof Packument.Type, CheckFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* HttpClient.filterStatusOk(HttpClient.withScope(client)).get(
      `${REGISTRY_URL}/${encodeURIComponent(name)}`
    );
    return yield* readPackument(response);
  }).pipe(
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.retry({
      times: 3,
      while: (failure) =>
        Cause.isTimeoutError(failure) ||
        (HttpClientError.isHttpClientError(failure) &&
          (failure.reason._tag === "TransportError" ||
            (failure.reason._tag === "StatusCodeError" &&
              (failure.reason.response.status === rateLimitedStatus ||
                failure.reason.response.status >= serverErrorMinimumStatus)))),
    }),
    Effect.mapError((failure) =>
      failure instanceof CheckFailed
        ? failure
        : new CheckFailed({
            message: `Could not read ${name} from the npm registry within the request policy`,
          })
    )
  );

const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.Boolean,
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const Bunfig = Schema.Struct({
  install: Schema.Struct({
    minimumReleaseAge: Schema.Finite,
    minimumReleaseAgeExcludes: Schema.optional(Schema.Array(Schema.String)),
  }),
});

const ScaConfig = Schema.Struct({
  sca: Schema.Struct({
    exclusions: Schema.optional(
      Schema.Array(
        Schema.Struct({
          CVE: Schema.String,
          paths: Schema.Array(Schema.String),
        })
      )
    ),
  }),
});

type Exclusion = {
  readonly cve: string;
  readonly path: string;
};

/** Deferred updates and accepted vulnerabilities expire at an exclusive UTC instant. */
const Policy = Schema.Struct({
  deferredUpdates: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      /** Repo-relative manifest path; absence covers every manifest pinning the package. */
      manifest: Schema.optional(Schema.String),
      reason: Schema.NonEmptyString,
      until: Schema.DateTimeUtcFromString,
    })
  ),
  /** Accepted advisories must have a reason and expiry, matched to the scanner exclusion. */
  acceptedVulnerabilities: Schema.Array(
    Schema.Struct({
      cve: Schema.String,
      /** The lockfile this acceptance speaks for, as `sca.exclusions` spells it — `tools/mutation/bun.lock`. Never a wildcard: the same advisory in a second install is a second decision. */
      path: Schema.String,
      reason: Schema.NonEmptyString,
      until: Schema.DateTimeUtcFromString,
    })
  ),
});

type Deferral = (typeof Policy.Type)["deferredUpdates"][number];

type Acceptance = (typeof Policy.Type)["acceptedVulnerabilities"][number];

const readJson = <A>(
  schema: Schema.Codec<A, unknown>,
  path: string
): Effect.Effect<A, CheckFailed> =>
  Effect.tryPromise({
    try: () => Bun.file(`${REPO_ROOT}${path}`).json(),
    catch: (cause) => new CheckFailed({ message: `Could not read ${path}: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(
      (cause) =>
        new CheckFailed({
          message: `${path} is not the shape this check expects: ${String(cause)}`,
        })
    )
  );

/** Missing or invalid scanner configuration fails the check rather than yielding policy findings. */
const readYaml = <A>(
  schema: Schema.Codec<A, unknown>,
  path: string
): Effect.Effect<A, CheckFailed> =>
  Effect.tryPromise({
    try: () => Bun.file(`${REPO_ROOT}${path}`).text(),
    catch: (cause) => new CheckFailed({ message: `Could not read ${path}: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => Bun.YAML.parse(text),
        catch: (cause) =>
          new CheckFailed({ message: `${path} is not valid YAML: ${String(cause)}` }),
      })
    ),
    Effect.flatMap((parsed) =>
      Effect.mapError(
        Schema.decodeUnknownEffect(schema)(parsed),
        (cause) =>
          new CheckFailed({
            message: `${path} is not the shape this check expects: ${String(cause)}`,
          })
      )
    )
  );

/** Missing or invalid install settings return None and are reported as policy findings. */
const readBunfig = (directory: string): Effect.Effect<Option.Option<typeof Bunfig.Type>> =>
  Effect.tryPromise(() => Bun.file(`${REPO_ROOT}${directory}bunfig.toml`).text()).pipe(
    Effect.flatMap((text) => Effect.try(() => Bun.TOML.parse(text))),
    Effect.flatMap(Schema.decodeUnknownEffect(Bunfig)),
    Effect.asSome,
    Effect.orElseSucceed(() => Option.none<typeof Bunfig.Type>())
  );

const manifestPaths = (): ReadonlyArray<string> =>
  MANIFEST_PATTERNS.flatMap((pattern) => [
    ...new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT, dot: false }),
  ])
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !path.startsWith("node_modules/") && !path.includes("/node_modules/"))
    .sort((left, right) => left.localeCompare(right));

const pinsOf = (manifest: string, declared: typeof Manifest.Type): ReadonlyArray<Pin> =>
  [
    ...Object.entries(declared.dependencies ?? {}),
    ...Object.entries(declared.devDependencies ?? {}),
  ].map(([name, spec]) => ({ name, manifest, spec }));

const externalPinsOf = (
  manifests: ReadonlyArray<Readonly<{ declared: typeof Manifest.Type; manifest: string }>>
): ReadonlyArray<Pin> => {
  const workspaceVersions = new Map(
    manifests
      .filter(({ declared }) => declared.private)
      .map(({ declared }) => [declared.name, declared.version] as const)
  );
  return manifests
    .flatMap(({ declared, manifest }) => pinsOf(manifest, declared))
    .filter(
      ({ name, spec }) =>
        workspaceVersions.get(name) === undefined ||
        spec !== `workspace:${workspaceVersions.get(name)}`
    );
};

const bunfigFindings = ({
  directory,
  bunfig,
}: {
  readonly directory: string;
  readonly bunfig: Option.Option<typeof Bunfig.Type>;
}): ReadonlyArray<Finding> => {
  const path = `${directory}bunfig.toml`;

  if (Option.isNone(bunfig)) {
    return [
      {
        severity: "failure",
        subject: path,
        detail:
          `no \`install.minimumReleaseAge\` here, so \`bun install\` in this directory will take a release published minutes ago.\n` +
          `  Declare the ${RELEASE_DELAY_SECONDS}-second delay, matching the root bunfig — and nothing else: no exclude list.`,
      },
    ];
  }

  const install = bunfig.value.install;
  const short =
    install.minimumReleaseAge < RELEASE_DELAY_SECONDS
      ? [
          {
            severity: "failure" as const,
            subject: path,
            detail:
              `install.minimumReleaseAge is ${install.minimumReleaseAge}s, below the ${RELEASE_DELAY_SECONDS}s this repo requires.\n` +
              `  A release younger than the delay is a supply-chain landing window, and this gate ignores that window when it looks for updates.`,
          },
        ]
      : [];
  const holes = (install.minimumReleaseAgeExcludes ?? []).map((excluded) => ({
    severity: "failure" as const,
    subject: path,
    detail:
      `install.minimumReleaseAgeExcludes lets "${excluded}" skip the delay, and nothing earns that.\n` +
      `  The delay is what stops a release published minutes ago — the shape a compromised package arrives in — from reaching a machine here, and no fix is worth reopening it: a version nobody has had time to look at is the larger risk. Drop the exclude. If the version you need is a CVE fix too young to install, carry the vulnerability instead: accept it in ${SCA_CONFIG_PATH} until the delay lets the fix in.`,
  }));

  return [...short, ...holes];
};

const acceptanceFindings = ({
  exclusions,
  acceptances,
  startedAt,
}: {
  readonly exclusions: ReadonlyArray<Exclusion>;
  readonly acceptances: ReadonlyArray<Acceptance>;
  readonly startedAt: DateTime.Utc;
}): ReadonlyArray<Finding> =>
  exclusions.map((exclusion): Finding => {
    const subject = `${exclusion.cve} (${exclusion.path})`;
    const recorded =
      acceptances.find(
        (acceptance) => acceptance.cve === exclusion.cve && acceptance.path === exclusion.path
      ) ?? null;

    if (recorded === null) {
      return {
        severity: "failure",
        subject,
        detail:
          `${SCA_CONFIG_PATH} tells the scanner to stop counting this advisory here, and nothing in ${POLICY_PATH} says why.\n` +
          `  The finding is gone from the report but the vulnerability is still installed. Add an \`acceptedVulnerabilities\` entry giving the reason and the date it expires — or drop the exclusion and fix the dependency.`,
      };
    }

    return DateTime.isLessThan(startedAt, recorded.until)
      ? {
          severity: "warning",
          subject,
          detail: `accepted until ${DateTime.formatIsoDate(recorded.until)}, and installed until someone acts: ${recorded.reason}`,
        }
      : {
          severity: "failure",
          subject,
          detail:
            `the decision to ship this expired on ${DateTime.formatIsoDate(recorded.until)}, and the exclusion in ${SCA_CONFIG_PATH} outlived it.\n` +
            `  Recorded reason: ${recorded.reason}\n` +
            `  Fix the dependency and delete both, or record the decision again with a date and a reason that still hold.`,
        };
  });

const staleAcceptanceFindings = ({
  acceptances,
  exclusions,
}: {
  readonly acceptances: ReadonlyArray<Acceptance>;
  readonly exclusions: ReadonlyArray<Exclusion>;
}): ReadonlyArray<Finding> =>
  acceptances
    .filter(
      (acceptance) =>
        !exclusions.some(
          (exclusion) => exclusion.cve === acceptance.cve && exclusion.path === acceptance.path
        )
    )
    .map((acceptance) => ({
      severity: "failure" as const,
      subject: `${acceptance.cve} (${POLICY_PATH})`,
      detail:
        `acceptedVulnerabilities permits shipping this in ${acceptance.path}, which ${SCA_CONFIG_PATH} no longer excludes.\n` +
        `  Whatever it was written for is over, so delete the entry rather than leaving a standing permission behind.`,
    }));

const deferralFor = (
  deferrals: ReadonlyArray<Deferral>,
  pin: Pin,
  startedAt: DateTime.Utc
): Option.Option<Deferral> =>
  Arr.findFirst(
    deferrals,
    (deferral) =>
      deferral.name === pin.name &&
      (deferral.manifest === undefined || deferral.manifest === pin.manifest) &&
      DateTime.isLessThan(startedAt, deferral.until)
  );

const updateFinding = ({
  pin,
  release,
  deferral,
}: {
  readonly pin: ExactPin;
  readonly release: Release;
  readonly deferral: Option.Option<Deferral>;
}): Option.Option<Finding> => {
  const kind = step(pin.current, release.version);

  if (Option.isNone(kind)) {
    return Option.none();
  }

  const published = DateTime.formatIsoDate(release.publishedAt);
  const deferred = Option.match(deferral, {
    onNone: () => "",
    onSome: (active) =>
      `\n  deferred until ${DateTime.formatIsoDate(active.until)}: ${active.reason}`,
  });

  return Option.some({
    severity: Option.isNone(deferral) ? severityOf(kind.value) : "warning",
    subject: `${pin.name} (${pin.manifest})`,
    detail: `${kind.value} update available: ${pin.spec} → ${release.version.raw}, published ${published}${deferred}`,
  });
};

const pinFindings = ({
  pin,
  packument,
  startedAt,
  deferrals,
}: {
  readonly pin: ExactPin;
  readonly packument: typeof Packument.Type;
  readonly startedAt: DateTime.Utc;
  readonly deferrals: ReadonlyArray<Deferral>;
}): ReadonlyArray<Finding> => {
  const release = newestInstallable(packument, startedAt);

  if (Option.isNone(release)) {
    return [];
  }

  return Option.toArray(
    updateFinding({
      pin,
      release: release.value,
      deferral: deferralFor(deferrals, pin, startedAt),
    })
  );
};

const section = (title: string, findings: ReadonlyArray<Finding>): string =>
  findings.length === 0
    ? ""
    : `\n${title}\n\n${findings.map((finding) => `- ${finding.subject}\n  ${finding.detail}`).join("\n")}\n`;

const report = (checked: number, findings: ReadonlyArray<Finding>): string => {
  const failures = findings.filter((finding) => finding.severity === "failure");
  const warnings = findings.filter((finding) => finding.severity === "warning");

  return (
    `Dependency policy: ${checked} pins checked against the npm registry, ` +
    `ignoring releases younger than ${RELEASE_DELAY_SECONDS / SECONDS_PER_DAY} days.\n` +
    `${failures.length} failing, ${warnings.length} to review.\n` +
    section(
      "Failing — patch, minor and prerelease-to-stable steps are compatible, so not taking them is the defect:",
      failures
    ) +
    section(
      "Review — reported and not enforced, because each needs a human rather than a command: a major step needs someone with a changelog, an accepted vulnerability carries its own expiry:",
      warnings
    ) +
    (failures.length === 0 && warnings.length === 0 ? "\nEvery pin is current.\n" : "")
  );
};

const acceptedExclusions = (scanner: typeof ScaConfig.Type): ReadonlyArray<Exclusion> =>
  scanner.sca.exclusions === undefined
    ? []
    : scanner.sca.exclusions.flatMap((exclusion) =>
        exclusion.paths.map((path) => ({ cve: exclusion.CVE, path }))
      );

const rangedPinFindings = (ranged: ReadonlyArray<Pin>): ReadonlyArray<Finding> =>
  ranged.map((pin) => ({
    severity: "failure" as const,
    subject: `${pin.name} (${pin.manifest})`,
    detail:
      `"${pin.spec}" is a range, not a pin. Which version is installed then lives in the lockfile, and this check would be grading a number nobody wrote down.\n` +
      `  Pin the exact version the lockfile resolved.`,
  }));

/** Evaluate the repository's dependency policy under the caller-owned HTTP and Clock services. */
export const checkDependencyUpdates = Effect.gen(function* () {
  const startedAt = yield* DateTime.now;
  const policy = yield* readJson(Policy, POLICY_PATH);
  const scanner = yield* readYaml(ScaConfig, SCA_CONFIG_PATH);
  const manifests = manifestPaths();
  const exclusions = acceptedExclusions(scanner);

  const decodedManifests = yield* Effect.forEach(manifests, (manifest) =>
    Effect.map(readJson(Manifest, manifest), (declared) => ({ declared, manifest }))
  );
  const externalPins = externalPinsOf(decodedManifests);

  const installSettings = yield* Effect.forEach(manifests, (manifest) => {
    const directory = manifest.slice(0, manifest.length - "package.json".length);

    return Effect.map(readBunfig(directory), (bunfig) => bunfigFindings({ directory, bunfig }));
  });

  const declared = externalPins.map((pin) => ({ pin, current: parsePin(pin.spec) }));
  const ranged = declared.flatMap(({ pin, current }) => (Option.isNone(current) ? [pin] : []));
  const exact = declared.flatMap(({ pin, current }): ReadonlyArray<ExactPin> =>
    Option.isNone(current) ? [] : [{ ...pin, current: current.value }]
  );

  const updates = yield* Effect.forEach(
    exact,
    (pin) =>
      Effect.map(fetchPackument(pin.name), (packument) =>
        pinFindings({ pin, packument, startedAt, deferrals: policy.deferredUpdates })
      ),
    { concurrency: REGISTRY_CONCURRENCY }
  );

  const findings = [
    ...installSettings.flat(),
    ...acceptanceFindings({
      exclusions,
      acceptances: policy.acceptedVulnerabilities,
      startedAt,
    }),
    ...staleAcceptanceFindings({
      acceptances: policy.acceptedVulnerabilities,
      exclusions,
    }),
    ...rangedPinFindings(ranged),
    ...updates.flat(),
  ];

  yield* Console.log(report(exact.length, findings));

  return findings.some((finding) => finding.severity === "failure");
});

const main = Effect.scoped(
  Effect.flatMap(Layer.build(FetchHttpClient.layer), (services) =>
    Effect.provideContext(checkDependencyUpdates, services)
  )
).pipe(
  Effect.catchTag("CheckFailed", (failure) =>
    Effect.as(Console.error(`Dependency policy check could not run.\n${failure.message}`), true)
  ),
  Effect.flatMap((failed) => Effect.sync(() => process.exit(failed ? 1 : 0)))
);

if (import.meta.main) {
  Effect.runPromise(main).catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
