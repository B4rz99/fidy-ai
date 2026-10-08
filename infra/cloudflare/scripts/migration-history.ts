import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const migrationNameMaximumCharacters = 70;
const migrationNamePattern = /^[0-9]{4,}_[a-z0-9_]+\.sql$/u;
const MigrationName = Schema.String.check(
  Schema.isPattern(migrationNamePattern),
  Schema.isMaxLength(migrationNameMaximumCharacters)
);
const MigrationHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const MigrationRepairCommitSha = Schema.String.check(
  Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
);
export const MigrationRepairRepository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
);

export const AppliedMigration = Schema.Struct({
  name: MigrationName,
  hash: MigrationHash,
});
export type AppliedMigration = typeof AppliedMigration.Type;

const WranglerLedgerRow = Schema.Struct({
  name: MigrationName,
  hash: MigrationHash,
  ledger_count: Schema.Finite,
});
const WranglerQueryResult = Schema.Struct({
  success: Schema.Literal(true),
  results: Schema.Array(WranglerLedgerRow),
});
const WranglerQueryOutput = Schema.Tuple([WranglerQueryResult]);

export type MigrationSource = {
  readonly name: string;
  readonly source: string;
};

export type HashedMigrationSource = {
  readonly name: string;
  readonly hash: string;
};

export type AppliedMigrationDrift =
  | { readonly _tag: "DuplicateAppliedName"; readonly name: string }
  | { readonly _tag: "MissingSourceFile"; readonly name: string }
  | { readonly _tag: "HashMismatch"; readonly name: string };

const hasCompleteMigrationRowCount = (
  rows: ReadonlyArray<typeof WranglerLedgerRow.Type>
): boolean => {
  const reportedCount = rows.at(0)?.ledger_count;
  return (
    reportedCount !== undefined &&
    reportedCount <= maximumAppliedMigrationRows &&
    reportedCount === rows.length &&
    rows.every((row) => row.ledger_count === reportedCount)
  );
};

export const decodeWranglerMigrationRows = (json: string): ReadonlyArray<AppliedMigration> => {
  const [statement] = Schema.decodeUnknownSync(WranglerQueryOutput)(JSON.parse(json));
  const rows = statement.results;
  if (rows.length === 0) return [];
  if (!hasCompleteMigrationRowCount(rows)) {
    throw new Error("D1 migration ledger query returned an incomplete result");
  }

  return rows.map(({ name, hash }) => ({ name, hash }));
};

export const maximumAppliedMigrationRows = 1_000;

export const hashMigrationSources = Effect.fn("hashMigrationSources")(function* (
  sources: ReadonlyArray<MigrationSource>
) {
  const crypto = yield* Crypto.Crypto;
  return yield* Effect.forEach(sources, ({ name, source }) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(source))
      .pipe(Effect.map((digest) => ({ name, hash: Hex.encode(digest) })))
  );
});

export const compareAppliedMigrationRows = Effect.fn("compareAppliedMigrationRows")(
  (applied: ReadonlyArray<AppliedMigration>, checkedIn: ReadonlyArray<HashedMigrationSource>) =>
    Effect.sync((): ReadonlyArray<AppliedMigrationDrift> => {
      const checkedInByName = new Map(checkedIn.map(({ name, hash }) => [name, hash]));
      const seenNames = new Set<string>();
      const drift: Array<AppliedMigrationDrift> = [];

      for (const migration of applied) {
        if (seenNames.has(migration.name)) {
          drift.push({ _tag: "DuplicateAppliedName", name: migration.name });
          continue;
        }
        seenNames.add(migration.name);

        const hash = checkedInByName.get(migration.name);
        if (hash === undefined) {
          drift.push({ _tag: "MissingSourceFile", name: migration.name });
        } else if (hash !== migration.hash) {
          drift.push({ _tag: "HashMismatch", name: migration.name });
        }
      }

      return drift;
    })
);

export type GitMigrationChange = {
  readonly status: "A" | "M" | "D" | "T";
  readonly path: string;
};

const GitChangeStatus = Schema.Literals(["A", "M", "D", "T"]);
const migrationPathPrefix = "apps/server/cloudflare/migrations/";

export const parseGitMigrationChanges = (output: string): ReadonlyArray<GitMigrationChange> => {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  if (parts.length % 2 !== 0) throw new Error("Malformed NUL-delimited Git migration diff");

  const changes: Array<GitMigrationChange> = [];
  for (let index = 0; index < parts.length; index += 2) {
    const status = Schema.decodeUnknownSync(GitChangeStatus)(parts[index]);
    const path = parts[index + 1] ?? "";
    if (path.length === 0) {
      throw new Error("Malformed path in Git migration diff");
    }
    if (path.startsWith(migrationPathPrefix) && path.endsWith(".sql")) {
      changes.push({ status, path });
    }
  }
  return changes;
};

const MigrationRepairStatus = Schema.Struct({
  id: Schema.Finite,
  context: Schema.String,
  state: Schema.Literals(["error", "failure", "pending", "success"]),
  created_at: Schema.String,
  target_url: Schema.OptionFromNullOr(Schema.String),
  creator: Schema.Struct({ login: Schema.String }),
});
export type MigrationRepairStatus = typeof MigrationRepairStatus.Type;

const GitHubStatuses = Schema.Union([
  Schema.Array(MigrationRepairStatus),
  Schema.Array(Schema.Array(MigrationRepairStatus)),
]);
const ProductionWorkflowRun = Schema.Struct({
  status: Schema.String,
  updated_at: Schema.String,
});
const ProductionWorkflowRuns = Schema.Struct({
  workflow_runs: Schema.Array(ProductionWorkflowRun),
});

export type ProductionWorkflowRunSnapshot = {
  readonly status: string;
  readonly updatedAt: number;
};

export const decodeMigrationRepairStatuses = (json: string): ReadonlyArray<MigrationRepairStatus> =>
  Schema.decodeUnknownSync(GitHubStatuses)(JSON.parse(json)).flat();

export const decodeLatestProductionWorkflowRun = (
  json: string
): Option.Option<ProductionWorkflowRunSnapshot> => {
  const { workflow_runs: runs } = Schema.decodeUnknownSync(ProductionWorkflowRuns)(
    JSON.parse(json)
  );
  const latest = runs.at(0);
  if (latest === undefined) return Option.none();

  const updatedAt = Date.parse(latest.updated_at);
  if (!Number.isFinite(updatedAt)) throw new Error("Invalid Production workflow run timestamp");
  return Option.some({ status: latest.status, updatedAt });
};

export const decodeMigrationRepairName = (value: unknown): string =>
  Schema.decodeUnknownSync(MigrationName)(value);

export const migrationRepairContext = (name: string): string =>
  `d1-migration-repair/${decodeMigrationRepairName(name)}`;

const latestStatusesByContext = (
  statuses: ReadonlyArray<MigrationRepairStatus>
): ReadonlyMap<string, MigrationRepairStatus> => {
  const latestByContext = new Map<string, MigrationRepairStatus>();
  for (const status of statuses) {
    const latest = latestByContext.get(status.context);
    if (latest === undefined || status.id > latest.id) {
      latestByContext.set(status.context, status);
    }
  }
  return latestByContext;
};

const statusReferencesSameWorkflowRun = (
  approval: MigrationRepairStatus,
  pending: MigrationRepairStatus
): boolean =>
  Option.match(approval.target_url, {
    onNone: () => false,
    onSome: (targetUrl) =>
      Option.match(pending.target_url, {
        onNone: () => false,
        onSome: (pendingTargetUrl) => pendingTargetUrl === targetUrl,
      }),
  });

const isPendingForApproval = (
  approval: MigrationRepairStatus,
  status: MigrationRepairStatus
): boolean =>
  status.id < approval.id &&
  status.context === approval.context &&
  status.state === "pending" &&
  status.creator.login === "github-actions[bot]" &&
  statusReferencesSameWorkflowRun(approval, status);

const matchingPendingVerification = (
  approval: MigrationRepairStatus,
  statuses: ReadonlyArray<MigrationRepairStatus>
): Option.Option<MigrationRepairStatus> => {
  let latestPending = Option.none<MigrationRepairStatus>();
  for (const status of statuses) {
    if (!isPendingForApproval(approval, status)) continue;
    latestPending = Option.match(latestPending, {
      onNone: () => Option.some(status),
      onSome: (latest) => (latest.id < status.id ? Option.some(status) : latestPending),
    });
  }
  return latestPending;
};

const verificationStartedAt = (
  approval: MigrationRepairStatus,
  statuses: ReadonlyArray<MigrationRepairStatus>
): Option.Option<number> =>
  Option.match(matchingPendingVerification(approval, statuses), {
    onNone: () => Option.none(),
    onSome: (pending) => {
      const timestamp = Date.parse(pending.created_at);
      return Number.isFinite(timestamp) ? Option.some(timestamp) : Option.none();
    },
  });

type MigrationRepairApprovalEvidence = {
  readonly statusesByContext: ReadonlyMap<string, MigrationRepairStatus>;
  readonly statuses: ReadonlyArray<MigrationRepairStatus>;
  readonly latestProductionRun: Option.Option<ProductionWorkflowRunSnapshot>;
};

const isApprovedMigration = (name: string, evidence: MigrationRepairApprovalEvidence): boolean => {
  const latest = evidence.statusesByContext.get(migrationRepairContext(name));
  if (latest?.state !== "success" || latest.creator.login !== "github-actions[bot]") return false;

  const startedAt = verificationStartedAt(latest, evidence.statuses);
  if (Option.isNone(startedAt)) return false;

  return Option.match(evidence.latestProductionRun, {
    onNone: () => false,
    onSome: (run) => run.status === "completed" && run.updatedAt <= startedAt.value,
  });
};

export const unapprovedMigrationChanges = Effect.fn("unapprovedMigrationChanges")(
  (
    changes: ReadonlyArray<GitMigrationChange>,
    statuses: ReadonlyArray<MigrationRepairStatus>,
    latestProductionRun: Option.Option<ProductionWorkflowRunSnapshot>
  ) =>
    Effect.sync((): ReadonlyArray<string> => {
      const evidence = {
        statusesByContext: latestStatusesByContext(statuses),
        statuses,
        latestProductionRun,
      };
      const unapproved: Array<string> = [];
      for (const change of changes) {
        if (change.status === "A") continue;

        const name = change.path.slice(migrationPathPrefix.length);
        if (!isApprovedMigration(name, evidence)) {
          unapproved.push(name);
        }
      }
      return unapproved;
    })
);

const PullRequestFile = Schema.Struct({
  filename: Schema.String,
  status: Schema.String,
  previous_filename: Schema.optionalKey(Schema.String),
});
export type PullRequestFile = typeof PullRequestFile.Type;

export const decodePullRequestFiles = (json: string): ReadonlyArray<PullRequestFile> =>
  Schema.decodeUnknownSync(
    Schema.Union([Schema.Array(PullRequestFile), Schema.Array(Schema.Array(PullRequestFile))])
  )(JSON.parse(json)).flat();

export const containsRepairableMigrationChange = Effect.fn("containsRepairableMigrationChange")(
  (name: string, files: ReadonlyArray<PullRequestFile>) =>
    Effect.sync(() => {
      const target = `${migrationPathPrefix}${decodeMigrationRepairName(name)}`;
      return files.some(
        (file) =>
          (file.filename === target && (file.status === "modified" || file.status === "removed")) ||
          (file.status === "renamed" && file.previous_filename === target)
      );
    })
);
