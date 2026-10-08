import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  MigrationRepairCommitSha,
  MigrationRepairRepository,
  compareAppliedMigrationRows,
  containsRepairableMigrationChange,
  decodeLatestProductionWorkflowRun,
  decodeMigrationRepairStatuses,
  decodePullRequestFiles,
  decodeWranglerMigrationRows,
  hashMigrationSources,
  parseGitMigrationChanges,
  unapprovedMigrationChanges,
} from "./migration-history";

const migrationDirectory = "apps/server/cloudflare/migrations/";
const firstMigration = "0001_users.sql";
const secondMigration = "0002_categories.sql";
const firstMigrationHash = "6869107c4910d8df4680ee89aff9924b65ae79c81b5b78478f2b12f90254f6c5";
const firstMigrationSource = "CREATE TABLE users (id INTEGER PRIMARY KEY);\n";
const repairRunUrl = "https://github.com/B4rz99/fidy-ai/actions/runs/42";
const completedProductionRun = Option.some({
  status: "completed",
  updatedAt: Date.parse("2026-09-01T12:00:00.000Z"),
});
const approvedRepairStatuses = [
  {
    id: 10,
    context: "d1-migration-repair/0001_users.sql",
    state: "pending" as const,
    created_at: "2026-09-01T12:01:00.000Z",
    target_url: Option.some(repairRunUrl),
    creator: { login: "github-actions[bot]" },
  },
  {
    id: 11,
    context: "d1-migration-repair/0001_users.sql",
    state: "success" as const,
    created_at: "2026-09-01T12:02:00.000Z",
    target_url: Option.some(repairRunUrl),
    creator: { login: "github-actions[bot]" },
  },
] as const;

describe("D1 migration history policy", () => {
  it("decodes every slurped GitHub page without losing later migration evidence", () => {
    const files = decodePullRequestFiles(
      JSON.stringify([
        [{ filename: `${migrationDirectory}unrelated.sql`, status: "added" }],
        [{ filename: `${migrationDirectory}${firstMigration}`, status: "removed" }],
      ])
    );
    expect(Effect.runSync(containsRepairableMigrationChange(firstMigration, files))).toBe(true);
    const status = {
      id: 11,
      context: `d1-migration-repair/${firstMigration}`,
      state: "success",
      created_at: "2026-09-01T12:02:00.000Z",
      target_url: repairRunUrl,
      creator: { login: "github-actions[bot]" },
    };
    expect(decodeMigrationRepairStatuses(JSON.stringify([[], [status]]))).toEqual([
      { ...status, target_url: Option.some(repairRunUrl) },
    ]);
    expect(() => decodePullRequestFiles(JSON.stringify([[], [{ status: "removed" }]]))).toThrow();
    expect(() =>
      decodeMigrationRepairStatuses(JSON.stringify([[], [{ ...status, state: "invalid" }]]))
    ).toThrow();
  });

  it("validates repair commit and repository identities", () => {
    expect(Schema.decodeUnknownSync(MigrationRepairCommitSha)("a".repeat(40))).toBe("a".repeat(40));
    expect(Schema.decodeUnknownSync(MigrationRepairCommitSha)("b".repeat(64))).toBe("b".repeat(64));
    expect(Schema.decodeUnknownSync(MigrationRepairRepository)("owner/repository")).toBe(
      "owner/repository"
    );
    expect(() => Schema.decodeUnknownSync(MigrationRepairCommitSha)("a".repeat(39))).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MigrationRepairRepository)("owner/repository/extra")
    ).toThrow();
  });

  it("accepts applied hashes and leaves a newly checked-in migration pending", () => {
    expect(
      Effect.runSync(
        compareAppliedMigrationRows(
          [{ name: firstMigration, hash: firstMigrationHash }],
          [
            { name: firstMigration, hash: firstMigrationHash },
            { name: secondMigration, hash: "0".repeat(64) },
          ]
        )
      )
    ).toEqual([]);
  });

  it("detects source edits and missing files for applied migration names", () => {
    expect(
      Effect.runSync(
        compareAppliedMigrationRows(
          [
            { name: firstMigration, hash: firstMigrationHash },
            { name: secondMigration, hash: firstMigrationHash },
          ],
          [{ name: firstMigration, hash: "0".repeat(64) }]
        )
      )
    ).toEqual([
      { _tag: "HashMismatch", name: firstMigration },
      { _tag: "MissingSourceFile", name: secondMigration },
    ]);
  });

  it("rejects duplicate names in the applied migration ledger", () => {
    expect(
      Effect.runSync(
        compareAppliedMigrationRows(
          [
            { name: firstMigration, hash: firstMigrationHash },
            { name: firstMigration, hash: firstMigrationHash },
          ],
          [{ name: firstMigration, hash: firstMigrationHash }]
        )
      )
    ).toEqual([{ _tag: "DuplicateAppliedName", name: firstMigration }]);
  });

  it("decodes only successful Wrangler query results with valid migration hashes", () => {
    expect(
      decodeWranglerMigrationRows(
        JSON.stringify([
          {
            results: [{ name: firstMigration, hash: firstMigrationHash, ledger_count: 1 }],
            success: true,
            meta: { duration: 1 },
          },
        ])
      )
    ).toEqual([{ name: firstMigration, hash: firstMigrationHash }]);

    expect(() => decodeWranglerMigrationRows("[]")).toThrow();
    expect(() =>
      decodeWranglerMigrationRows(
        JSON.stringify([
          { results: [], success: true },
          { results: [], success: true },
        ])
      )
    ).toThrow();
    expect(() =>
      decodeWranglerMigrationRows(JSON.stringify([{ results: [], success: false }]))
    ).toThrow();
    expect(() =>
      decodeWranglerMigrationRows(
        JSON.stringify([
          {
            results: [{ name: firstMigration, hash: "not-a-hash", ledger_count: 1 }],
            success: true,
          },
        ])
      )
    ).toThrow();
    expect(() =>
      decodeWranglerMigrationRows(
        JSON.stringify([
          {
            results: [{ name: firstMigration, hash: firstMigrationHash, ledger_count: 2 }],
            success: true,
          },
        ])
      )
    ).toThrow();
  });

  it("decodes the latest Production run and fails closed on incomplete timestamps", () => {
    expect(
      decodeLatestProductionWorkflowRun(
        JSON.stringify({
          workflow_runs: [{ status: "completed", updated_at: "2026-09-01T12:00:00.000Z" }],
        })
      )
    ).toEqual(completedProductionRun);
    expect(decodeLatestProductionWorkflowRun(JSON.stringify({ workflow_runs: [] }))).toEqual(
      Option.none()
    );
    expect(() =>
      decodeLatestProductionWorkflowRun(
        JSON.stringify({ workflow_runs: [{ status: "completed", updated_at: "invalid" }] })
      )
    ).toThrow();
  });

  it("parses NUL-delimited Git changes without treating an added migration as a repair", () => {
    const changes = parseGitMigrationChanges(
      `A\0${migrationDirectory}${secondMigration}\0M\0${migrationDirectory}${firstMigration}\0`
    );

    expect(changes).toEqual([
      { status: "A", path: `${migrationDirectory}${secondMigration}` },
      { status: "M", path: `${migrationDirectory}${firstMigration}` },
    ]);
    expect(Effect.runSync(unapprovedMigrationChanges(changes, [], Option.none()))).toEqual([
      firstMigration,
    ]);
    expect(
      Effect.runSync(
        unapprovedMigrationChanges(
          [{ status: "A", path: `${migrationDirectory}${secondMigration}` }],
          [],
          Option.none()
        )
      )
    ).toEqual([]);
  });

  it("requires exact successful approval for every changed existing migration", () => {
    const changedMigration = {
      status: "M",
      path: `${migrationDirectory}${firstMigration}`,
    } as const;
    const latestProductionRun = completedProductionRun;

    expect(
      Effect.runSync(unapprovedMigrationChanges([changedMigration], [], latestProductionRun))
    ).toEqual([firstMigration]);
    expect(
      Effect.runSync(
        unapprovedMigrationChanges(
          [changedMigration],
          [approvedRepairStatuses[1]],
          latestProductionRun
        )
      )
    ).toEqual([firstMigration]);
    expect(
      Effect.runSync(
        unapprovedMigrationChanges(
          [changedMigration],
          [
            approvedRepairStatuses[0],
            { ...approvedRepairStatuses[1], creator: { login: "some-user" } },
          ],
          latestProductionRun
        )
      )
    ).toEqual([firstMigration]);
    expect(
      Effect.runSync(
        unapprovedMigrationChanges([changedMigration], approvedRepairStatuses, latestProductionRun)
      )
    ).toEqual([]);
    expect(
      Effect.runSync(
        unapprovedMigrationChanges([changedMigration], approvedRepairStatuses, Option.none())
      )
    ).toEqual([firstMigration]);
    expect(
      Effect.runSync(
        unapprovedMigrationChanges(
          [changedMigration],
          approvedRepairStatuses,
          Option.some({
            status: "completed",
            updatedAt: Date.parse("2026-09-01T12:03:00.000Z"),
          })
        )
      )
    ).toEqual([firstMigration]);
    expect(
      Effect.runSync(
        unapprovedMigrationChanges(
          [changedMigration],
          approvedRepairStatuses,
          Option.some({
            status: "in_progress",
            updatedAt: Date.parse("2026-09-01T11:59:00.000Z"),
          })
        )
      )
    ).toEqual([firstMigration]);
    expect(
      Effect.runSync(
        unapprovedMigrationChanges(
          [changedMigration],
          [
            ...approvedRepairStatuses,
            { ...approvedRepairStatuses[1], id: 12, state: "pending" as const },
          ],
          latestProductionRun
        )
      )
    ).toEqual([firstMigration]);
  });

  it("requires approval for a rename's deleted predecessor, not its new file", () => {
    const renameAsGitChanges = [
      { status: "D", path: `${migrationDirectory}${firstMigration}` },
      { status: "A", path: `${migrationDirectory}0003_users_corrected.sql` },
    ] as const;

    expect(
      Effect.runSync(unapprovedMigrationChanges(renameAsGitChanges, [], Option.none()))
    ).toEqual([firstMigration]);
    expect(
      Effect.runSync(
        unapprovedMigrationChanges(
          renameAsGitChanges,
          approvedRepairStatuses,
          completedProductionRun
        )
      )
    ).toEqual([]);
  });

  it("approves only an existing migration file changed in the requested PR", () => {
    const modified = decodePullRequestFiles(
      JSON.stringify([{ filename: `${migrationDirectory}${firstMigration}`, status: "modified" }])
    );
    const renamed = decodePullRequestFiles(
      JSON.stringify([
        {
          filename: `${migrationDirectory}0003_users_corrected.sql`,
          previous_filename: `${migrationDirectory}${firstMigration}`,
          status: "renamed",
        },
      ])
    );
    const added = decodePullRequestFiles(
      JSON.stringify([{ filename: `${migrationDirectory}${firstMigration}`, status: "added" }])
    );

    expect(Effect.runSync(containsRepairableMigrationChange(firstMigration, modified))).toBe(true);
    expect(Effect.runSync(containsRepairableMigrationChange(firstMigration, renamed))).toBe(true);
    expect(Effect.runSync(containsRepairableMigrationChange(firstMigration, added))).toBe(false);
  });

  it("hashes the exact checked-in SQL bytes with SHA-256", async () => {
    const hashes = await Effect.runPromise(
      hashMigrationSources([{ name: firstMigration, source: firstMigrationSource }]).pipe(
        Effect.provide(BunCrypto.layer)
      )
    );

    expect(hashes).toEqual([{ name: firstMigration, hash: firstMigrationHash }]);
  });
});
