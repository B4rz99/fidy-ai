#!/usr/bin/env bun

// Dependencies rot quietly. Nothing in the repo notices that a pin is eight
// months behind, because a stale pin builds, typechecks and tests exactly as
// well as a current one — right up to the day it is a published CVE, or a
// three-major-version jump nobody has budget for. This gate is the thing that
// notices.
//
// It grades by the size of the step, because the size of the step is what
// decides who has to be in the room:
//
//   * A patch or a minor is, by the semver contract the publisher accepted,
//     compatible. Not taking it is a decision, and an unmade decision is a
//     defect — so those FAIL. `bun update` is usually the whole fix.
//   * A major is a breaking change. It needs someone to read a changelog, so
//     the gate reports it and stays green: a WARNING. Failing here would only
//     teach the team to ignore a red job it cannot fix in a pull request.
//   * A pin still sitting on a prerelease after that version went stable is
//     the same "compatible step not taken" as a patch, and FAILS with them.
//     Every `effect` pin in this repo is a beta, so this is the case that will
//     fire the day v4 ships.
//
// Two rules exist to keep the first one honest.
//
// Specs must be exact — no `^`, no `~`. With a range, "which version is
// installed" is a question about the lockfile rather than the manifest, and
// the gate would be grading a number nobody wrote down. Every manifest in the
// repo is already pinned this way; this is what stops the first range from
// arriving unnoticed.
//
// And every install root must declare bunfig's `minimumReleaseAge` with no
// excludes, which is what stops the *other* direction of failure: a release
// published minutes ago is a supply-chain attack's landing window, not
// freshness. That rule has no escape hatch. A fix for a published CVE is the
// hardest case it faces and still does not earn one — a release nobody has had
// time to look at is the larger risk — so the delay holds and the
// vulnerability is carried instead, as an `sca.exclusions` entry in the
// scanner's config. The same delay is the window this gate ignores when it
// looks for the newest release, since demanding versions `bun install` is
// configured to refuse would set the two halves of the policy fighting.
//
// Both escape hatches live in dependency-policy.json and both are dated:
// `deferredUpdates` for a step not taken, `acceptedVulnerabilities` for an
// advisory the scanner has been told to stop counting. Each names a reason and
// a date it stops working, and downgrades a failure to a warning rather than
// hiding it. Acceptances are checked in the other direction too — a record
// whose exclusion is gone fails, so a standing permission to ship a
// vulnerability cannot outlive the vulnerability it was written for.

import { BunRuntime } from "@effect/platform-bun";
import { Array as Arr, Console, Data, DateTime, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

/**
 * The check itself could not run — a manifest that will not parse, a registry
 * that will not answer. Distinct from a policy finding: a finding is news about
 * the repo, this is news about the check, and the two must not be reported as
 * though they were the same thing.
 */
class CheckFailed extends Data.TaggedError("CheckFailed")<{ readonly message: string }> {}

const REPO_ROOT = Bun.fileURLToPath(new URL("..", import.meta.url));

const REGISTRY_URL = "https://registry.npmjs.org";

/**
 * The supply-chain delay, in seconds, every install root's bunfig must declare
 * — and the age a release must reach before this gate will ask for it. One
 * constant for both halves on purpose: they are the same window seen from two
 * sides, and a gate demanding a version the installer refuses would be
 * unsatisfiable.
 */
const RELEASE_DELAY_SECONDS = 604_800;

const SECONDS_PER_DAY = 86_400;

/**
 * Manifests at most two directories deep — every depth in that range, not just
 * the two the repo happens to use today. Bounded so the scan never walks into
 * `node_modules`, whose own manifests are not ours to grade; dotted directories
 * are excluded by the scanner, which is what keeps the vendored `.repos/effect`
 * checkout out of the graded set.
 */
const MANIFEST_PATTERNS = ["package.json", "*/package.json", "*/*/package.json"];

const POLICY_PATH = "dependency-policy.json";

/** The SCA scanner's config — the one place that can tell it to stop counting an advisory. */
const SCA_CONFIG_PATH = ".fluidattacks/sca.yaml";

/** Concurrent registry requests. The registry is generous; this is politeness, not a rate limit. */
const REGISTRY_CONCURRENCY = 8;

/** An exact pin, and nothing else: `1.2.3`, or `1.2.3-beta.4`. A leading `^`, `~`, `>=` or `*` fails to match, which is the point. */
const EXACT_PIN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
/** SheetJS CE publishes fixed-version tarballs after the stale npm release. */
const EXACT_SHEETJS_CDN_PIN =
  /^https:\/\/cdn\.sheetjs\.com\/xlsx-(\d+)\.(\d+)\.(\d+)\/xlsx-\1\.\2\.\3\.tgz$/;

/** How the registry spells a released, non-prerelease version. */
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

/** A version as this gate compares them: three numbers, plus whether a prerelease tail followed. */
type Version = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** True for `4.0.0-beta.98`. A prerelease is behind its own stable release even though the three numbers match. */
  readonly prerelease: boolean;
  readonly raw: string;
};

/** One dependency as its manifest declares it. */
type Pin = {
  readonly name: string;
  /** Manifest path relative to the repo root, so failures name a file a reader can open. */
  readonly manifest: string;
  readonly spec: string;
};

/**
 * A pin whose spec parsed, carrying the version it parsed to. The parse happens
 * once, where failing to parse is itself a finding, and everything downstream
 * takes the version as a fact. Re-parsing later would mean inventing an answer
 * for a case that cannot happen — and the only answers available there compare
 * a release against itself, which reports nothing and grades no pin.
 */
type ExactPin = Pin & { readonly current: Version };

/** The size of the step from a pin to the newest release it could take. `stable` is the prerelease-to-release step, where the three numbers do not move at all. */
type Step = "major" | "minor" | "patch" | "stable";

type Severity = "failure" | "warning";

type Finding = {
  readonly severity: Severity;
  readonly subject: string;
  readonly detail: string;
};

// ---------------------------------------------------------------------------
// Judgement — pure, and the whole of the policy
// ---------------------------------------------------------------------------

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

/**
 * The step from `current` to `latest`, `None` when `latest` is not ahead —
 * which covers the ordinary case of an up-to-date pin, and the case of a pin
 * sitting on a prerelease of a major the registry has not shipped yet.
 */
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

/**
 * What a step costs the reader. Majors are breaking and need a human with a
 * changelog, so they are reported rather than enforced; everything else is a
 * compatible update the repo has simply not taken.
 */
const severityOf = (kind: Step): Severity => (kind === "major" ? "warning" : "failure");

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The slice of an npm packument this gate reads. `time` carries a publish
 * instant per version, which is how release age is judged; `dist-tags.latest`
 * is the boundary past which versions are prereleases the publisher has not
 * blessed, whatever their version string looks like.
 */
const Packument = Schema.Struct({
  "dist-tags": Schema.Struct({ latest: Schema.String }),
  time: Schema.Record(Schema.String, Schema.DateTimeUtcFromString),
});

type Release = {
  readonly version: Version;
  readonly publishedAt: DateTime.Utc;
};

/**
 * The newest stable release old enough to install, given the packument and the
 * moment the run started. `null` when the package has no such release at all —
 * a brand-new package, or one whose every stable version is younger than the
 * delay.
 *
 * Versions above the `latest` dist-tag are excluded even when they parse as
 * stable: publishing `5.0.0` under `next` while `latest` stays on `4.x` is how
 * a major is staged, and the gate must not read the staging area as the
 * release.
 */
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

const fetchPackument = (
  name: string
): Effect.Effect<typeof Packument.Type, CheckFailed, HttpClient.HttpClient> =>
  HttpClient.get(`${REGISTRY_URL}/${encodeURIComponent(name)}`).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Packument)),
    Effect.retry({ times: 3 }),
    Effect.mapError(
      (cause) =>
        new CheckFailed({
          message: `Could not read ${name} from the npm registry: ${String(cause)}`,
        })
    )
  );

// ---------------------------------------------------------------------------
// What the repo declares
// ---------------------------------------------------------------------------

const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

/**
 * The install settings this gate has an opinion about. The delay is required.
 * The exclude list is not, and is expected to be absent: the only value this
 * repo permits it to hold is nothing at all, and a key that can only ever say
 * nothing is better left out than written down and re-argued. It is read anyway
 * because a key that appears with something in it is exactly the finding.
 */
const Bunfig = Schema.Struct({
  install: Schema.Struct({
    minimumReleaseAge: Schema.Finite,
    minimumReleaseAgeExcludes: Schema.optional(Schema.Array(Schema.String)),
  }),
});

/**
 * The slice of the SCA scanner's config this gate grades: the advisories it has
 * been told to stop counting, each scoped to the lockfiles it was excused in.
 * The key is spelled `CVE` because that is the key the scanner reads; the rest
 * of the scanner's config is none of this gate's business and is ignored.
 *
 * `exclusions` is absent in a repo carrying no accepted vulnerabilities, which
 * is the state to aim for, so it is optional here rather than defaulted — the
 * distinction between "none" and "not written down" is not one this gate has to
 * invent an answer for.
 */
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

/**
 * One accepted vulnerability as the scanner config states it, flattened to the
 * pair the decision is actually about: this advisory, in this lockfile. The
 * scanner takes a list of paths per advisory as a shorthand; every path in it is
 * a separate risk in a separate install, and grading them together would let one
 * argument cover a file nobody thought about.
 */
type Exclusion = {
  readonly cve: string;
  readonly path: string;
};

/**
 * One deferred update: a step the repo has decided not to take yet, the reason,
 * and the date the decision expires. `until` is exclusive — a deferral dated
 * 2026-09-01 stops applying on 2026-09-01, so the entry cannot outlive the
 * conversation that created it.
 */
const Policy = Schema.Struct({
  deferredUpdates: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      /**
       * Which manifest the deferral speaks for, as `manifestPaths` spells it —
       * `tools/crap/package.json`. Absent means every manifest that pins the
       * package. Name it whenever the same package is pinned in more than one
       * place for different reasons: the isolated tool installs hold classic
       * TypeScript on purpose, and a name-only deferral for `typescript` would
       * quietly stop grading the root's pin as well.
       */
      manifest: Schema.optional(Schema.String),
      reason: Schema.NonEmptyString,
      until: Schema.DateTimeUtcFromString,
    })
  ),
  /**
   * Vulnerabilities the repo has decided to ship with, one per advisory and
   * lockfile. These exist because the install delay and the CVE scanner can want
   * opposite things: a fix published three days ago is both the only version
   * without the vulnerability and too young to install. The delay wins — it is
   * the control that stops a compromised release, and it blocks even an exact
   * pin — so the way out is to carry the vulnerability, not to weaken the delay.
   *
   * The scanner's own config has nowhere to say why an exclusion exists or when
   * it should be gone, so that lives here: an accepted vulnerability must give a
   * reason and expire, or it is simply a vulnerability nobody is looking at.
   */
  acceptedVulnerabilities: Schema.Array(
    Schema.Struct({
      /** The advisory, spelled as the scanner spells it — `CVE-2026-14257`. */
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

/**
 * The same read for YAML, which the scanner's config is written in. Unlike a
 * bunfig, a missing or unparseable file here stops the check rather than
 * becoming a finding: this gate's job is to grade what the scanner was told, and
 * it cannot report on a file it could not read as though the file said nothing.
 */
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

/**
 * The install settings an install root declares, or `null` when there is no
 * bunfig to read or it does not declare them. Absence is an answer here rather
 * than a broken check: an install root with no delay is exactly the thing this
 * gate exists to report, so it comes back as a finding and the run continues.
 */
const readBunfig = (directory: string): Effect.Effect<Option.Option<typeof Bunfig.Type>> =>
  Effect.tryPromise(() => Bun.file(`${REPO_ROOT}${directory}bunfig.toml`).text()).pipe(
    Effect.map((text) => Bun.TOML.parse(text)),
    Effect.flatMap(Schema.decodeUnknownEffect(Bunfig)),
    Effect.map(Option.some),
    Effect.catchCause(() => Effect.succeed(Option.none<typeof Bunfig.Type>()))
  );

/** Every manifest the repo owns, nearest first. `node_modules` is excluded by name and dotted directories by the scanner. */
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

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

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
  // An absent exclude list is the expected state and means what an empty one
  // would: nothing is let out of the delay. That is bun's own reading of the
  // missing key rather than a default invented here to cover a gap — there is no
  // third state for this key to be in, and nothing downstream to mislead.
  const holes = (install.minimumReleaseAgeExcludes ?? []).map((excluded) => ({
    severity: "failure" as const,
    subject: path,
    detail:
      `install.minimumReleaseAgeExcludes lets "${excluded}" skip the delay, and nothing earns that.\n` +
      `  The delay is what stops a release published minutes ago — the shape a compromised package arrives in — from reaching a machine here, and no fix is worth reopening it: a version nobody has had time to look at is the larger risk. Drop the exclude. If the version you need is a CVE fix too young to install, carry the vulnerability instead: accept it in ${SCA_CONFIG_PATH} until the delay lets the fix in.`,
  }));

  return [...short, ...holes];
};

/**
 * Vulnerabilities the scanner has been told to stop counting, graded against
 * what the repo wrote down about them. An exclusion with no record is a
 * vulnerability shipped for reasons nobody stated; one whose record has expired
 * is a decision that has outlived its argument. Both fail. A live record is a
 * warning, because it is a real vulnerability in a real install — visible every
 * run, and never quiet.
 */
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

/**
 * Acceptances the scanner config no longer uses. Left alone, a record expires
 * quietly, nobody notices, and the next exclusion of that advisory is waved
 * through by an argument made months ago about a version that is long gone.
 */
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

/** The active deferral for a pin, if the run started before its expiry. */
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

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

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

const check = Effect.gen(function* () {
  const startedAt = yield* DateTime.now;
  const policy = yield* readJson(Policy, POLICY_PATH);
  const scanner = yield* readYaml(ScaConfig, SCA_CONFIG_PATH);
  const manifests = manifestPaths();
  const exclusions = acceptedExclusions(scanner);

  const pins = yield* Effect.forEach(manifests, (manifest) =>
    Effect.map(readJson(Manifest, manifest), (declared) => pinsOf(manifest, declared))
  );

  const installSettings = yield* Effect.forEach(manifests, (manifest) => {
    const directory = manifest.slice(0, manifest.length - "package.json".length);

    return Effect.map(readBunfig(directory), (bunfig) => bunfigFindings({ directory, bunfig }));
  });

  const declared = pins.flat().map((pin) => ({ pin, current: parsePin(pin.spec) }));
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

// `Layer.build` rather than `Effect.provide`: the repo composes with layers and
// provides once, at the entry point (src/main.ts), and this is that point for
// this program.
const main = Effect.scoped(
  Effect.flatMap(Layer.build(FetchHttpClient.layer), (services) =>
    Effect.provideContext(check, services)
  )
).pipe(
  Effect.catchTag("CheckFailed", (failure) =>
    Effect.as(Console.error(`Dependency policy check could not run.\n${failure.message}`), true)
  ),
  Effect.flatMap((failed) => Effect.sync(() => process.exit(failed ? 1 : 0)))
);

BunRuntime.runMain(main);
