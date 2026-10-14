import { BunServices } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Clock, DateTime, Effect, FileSystem, Option } from "effect";
import { expect } from "vitest";
import { Database } from "bun:sqlite";
import { type CaseCommand } from "./contract";
import { runCaseRegister } from "./runtime";
import { caseDeadlines } from "./calendar";

const caseId = "10000000-0000-4000-8000-000000000001";
const reference = (index: number): string =>
  `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const receivedAtMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-09T17:00:00Z"));
const now = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-14T14:00:00Z"));
const receive = (
  kind: Extract<CaseCommand, { action: "Receive" }>["kind"]
): Extract<CaseCommand, { action: "Receive" }> => ({
  action: "Receive",
  commandId: reference(1),
  caseId,
  ownerRef: reference(2),
  requestRef: reference(3),
  scopeRef: reference(18),
  requester: "NonUser",
  kind,
  receivedAtMs,
});
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const clock = yield* Clock.Clock;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-titular-test-" });
  const directory = yield* fs.realPath(temporary);
  const request = (value: unknown): ReturnType<typeof runCaseRegister> =>
    runCaseRegister({ directory, request: value }).pipe(
      Effect.provideService(Clock.Clock, {
        monotonicTimeNanos: clock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        sleep: (duration) => clock.sleep(duration),
        currentTimeMillis: Effect.succeed(now),
        currentTimeMillisUnsafe: () => now,
      })
    );
  const submit = (command: CaseCommand): ReturnType<typeof request> =>
    request({ operation: "Apply", command });
  return { directory, fs, request, submit, read: request({ operation: "Read", caseId }) };
});

it.live(
  "tracks claim annotation and the original completion-review date without resetting the case clock",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const original = yield* setup.submit(receive("Complaint"));
      expect(original.targets.claimAnnotation).toEqual(Option.some("2026-10-13"));
      const completion = yield* setup.submit({
        action: "RequestCompletion",
        caseId,
        commandId: reference(101),
        revision: 0,
        evidenceRef: reference(102),
      });
      expect(completion.targets.completionReview).toEqual(Option.some("2026-12-14"));
      const repeated = yield* setup
        .submit({
          action: "RequestCompletion",
          caseId,
          commandId: reference(103),
          revision: 1,
          evidenceRef: reference(104),
        })
        .pipe(Effect.flip);
      expect(repeated.reason).toBe("InvalidTransition");
      const complete = yield* setup.submit({
        action: "RecordCompletion",
        caseId,
        commandId: reference(105),
        revision: 1,
        evidenceRef: reference(106),
      });
      const annotated = yield* setup.submit({
        action: "RecordClaimAnnotation",
        caseId,
        commandId: reference(107),
        revision: 2,
        evidenceRef: reference(108),
      });
      expect(Option.isSome(annotated.case.claimAnnotation)).toBe(true);
      expect(complete.case.receivedAtMs).toBe(original.case.receivedAtMs);
      expect(annotated.targets.response).toEqual(original.targets.response);
      expect(annotated.targets.completionReview).toEqual(completion.targets.completionReview);
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);

it.live(
  "records a non-User intake privately, preserves original receipt on replay, and refuses substituted replay",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const input = receive("Access");
      const first = yield* setup.submit(input);
      expect(first.case.requester).toBe("NonUser");
      expect(first.case.receivedAtMs).toBe(receivedAtMs);
      expect(first.case.delivery.status).toBe("NotPrepared");
      expect(yield* setup.submit(input)).toEqual(first);
      const changed = yield* setup.submit({ ...input, ownerRef: reference(4) }).pipe(Effect.flip);
      expect(changed.reason).toBe("Conflict");
      expect((yield* setup.read).case.revision).toBe(0);
      expect((yield* setup.fs.stat(`${setup.directory}/register.sqlite`)).mode & 0o777).toBe(0o600);
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);

it.live(
  "requires verification and an owner result before response, and uncertain delivery never becomes confirmed",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.submit(receive("Correction"));
      const refused = yield* setup
        .submit({
          action: "PrepareResponse",
          caseId,
          commandId: reference(4),
          revision: 0,
          evidenceRef: reference(5),
        })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("InvalidTransition");
      expect((yield* setup.read).case.revision).toBe(0);
      yield* setup.submit({
        action: "RecordVerification",
        caseId,
        commandId: reference(6),
        revision: 0,
        evidenceRef: reference(7),
      });
      yield* setup.submit({
        action: "RecordOwnerResult",
        caseId,
        commandId: reference(8),
        revision: 1,
        evidenceRef: reference(9),
      });
      yield* setup.submit({
        action: "PrepareResponse",
        caseId,
        commandId: reference(10),
        revision: 2,
        evidenceRef: reference(11),
      });
      const uncertain = yield* setup.submit({
        action: "DeliveryUncertain",
        caseId,
        commandId: reference(12),
        revision: 3,
        evidenceRef: reference(13),
      });
      expect(uncertain.case.delivery.status).toBe("Uncertain");
      expect((yield* setup.read).case.delivery.status).toBe("Uncertain");
      const confirmed = yield* setup.submit({
        action: "RecordResponse",
        caseId,
        commandId: reference(14),
        revision: 4,
        evidenceRef: reference(15),
      });
      expect(confirmed.case.delivery.status).toBe("Confirmed");
      expect(
        yield* setup
          .submit({
            action: "Assign",
            caseId,
            commandId: reference(16),
            revision: 3,
            ownerRef: reference(17),
          })
          .pipe(Effect.flip)
      ).toMatchObject({ reason: "Conflict" });
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);

it.live(
  "binds a recorded erasure withdrawal to its actual case receipt and refuses contradictory outcomes",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.submit(receive("Erasure"));
      yield* setup.submit({
        action: "RecordVerification",
        caseId,
        commandId: reference(201),
        revision: 0,
        evidenceRef: reference(202),
      });
      yield* setup.submit({
        action: "RecordWithdrawal",
        caseId,
        commandId: reference(203),
        revision: 1,
        evidenceRef: reference(204),
      });
      const addressed = {
        action: "ReferErasure",
        caseId,
        commandId: reference(205),
        revision: 2,
        evidenceRef: reference(206),
      } as const;
      for (const withdrawal of [
        { status: "Recorded", reference: reference(207) },
        { status: "NotRequested" },
      ] as const) {
        expect(yield* setup.submit({ ...addressed, withdrawal }).pipe(Effect.flip)).toMatchObject({
          reason: "InvalidTransition",
        });
      }
      const command = {
        ...addressed,
        withdrawal: { status: "Recorded", reference: reference(204) },
      } as const;
      const result = yield* setup.submit(command);
      expect(yield* setup.submit(command)).toEqual(result);
      expect(Option.getOrThrow(result.case.erasureHandoff).withdrawal).toEqual(command.withdrawal);
      expect(result.deletion).toBe("not-performed");
      for (const action of ["RecordWithdrawal", "RecordVerification"] as const) {
        expect(
          yield* setup
            .submit({
              action,
              caseId,
              commandId: reference(action === "RecordWithdrawal" ? 208 : 209),
              revision: 3,
              evidenceRef: reference(210),
            })
            .pipe(Effect.flip)
        ).toMatchObject({ reason: "InvalidTransition" });
      }
      expect((yield* setup.read).case).toEqual(result.case);
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);

it.live("keeps erasure a tracked handoff and never reports deletion", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    yield* setup.submit(receive("Erasure"));
    expect(
      yield* setup
        .submit({
          action: "ReferErasure",
          withdrawal: { status: "NotRequested" },
          caseId,
          commandId: reference(4),
          revision: 0,
          evidenceRef: reference(5),
        })
        .pipe(Effect.flip)
    ).toMatchObject({ reason: "InvalidTransition" });
    yield* setup.submit({
      action: "RecordVerification",
      caseId,
      commandId: reference(6),
      revision: 0,
      evidenceRef: reference(7),
    });
    const referred = yield* setup.submit({
      action: "ReferErasure",
      withdrawal: { status: "NotRequested" },
      caseId,
      commandId: reference(8),
      revision: 1,
      evidenceRef: reference(9),
    });
    expect(Option.getOrNull(referred.case.erasureHandoff)).toEqual({
      evidenceRef: reference(9),
      authorityRef: reference(7),
      scopeRef: receive("Erasure").scopeRef,
      withdrawal: { status: "NotRequested" },
    });
    expect(referred.deletion).toBe("not-performed");
  }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);

it.live("rejects personal request fields and unsafe storage without recording a case", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    expect(
      yield* setup
        .request({
          operation: "Apply",
          command: { ...receive("Access"), email: "private@example.test" },
        })
        .pipe(Effect.flip)
    ).toMatchObject({ reason: "InvalidInput" });
    expect(yield* setup.fs.exists(`${setup.directory}/register.sqlite`)).toBe(false);
    yield* setup.fs.chmod(setup.directory, 0o755);
    expect(yield* setup.submit(receive("Access")).pipe(Effect.flip)).toMatchObject({
      reason: "UnsafeStorage",
    });
    expect(yield* setup.fs.exists(`${setup.directory}/register.sqlite`)).toBe(false);
  }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);

it.live("counts Colombian holidays in conservative targets and refuses unsupported calendars", () =>
  Effect.sync(() => {
    const access = caseDeadlines({ kind: "Access", receivedDate: "2026-10-09" });
    expect(Option.getOrNull(access.response)).toBe("2026-10-21");
    expect(Option.getOrNull(access.maximumExtension)).toBe("2026-10-27");
    const complaint = caseDeadlines({ kind: "Complaint", receivedDate: "2026-10-09" });
    expect(Option.getOrNull(complaint.response)).toBe("2026-10-28");
    expect(Option.getOrNull(complaint.maximumExtension)).toBe("2026-11-07");
    expect(
      Option.isNone(caseDeadlines({ kind: "Access", receivedDate: "2027-12-30" }).response)
    ).toBe(true);
  })
);

it.live(
  "rolls a failed history append back and permits the same command to complete once after recovery",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.submit(receive("Access"));
      const database = yield* Effect.acquireRelease(
        Effect.sync(() => new Database(`${setup.directory}/register.sqlite`)),
        (db) => Effect.sync(() => db.close())
      );
      yield* Effect.sync(() =>
        database.exec(
          "CREATE TRIGGER fail_history BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'test_failure'); END"
        )
      );
      const command: CaseCommand = {
        action: "Assign",
        caseId,
        commandId: reference(4),
        revision: 0,
        ownerRef: reference(5),
      };
      expect(yield* setup.submit(command).pipe(Effect.flip)).toMatchObject({
        reason: "Unavailable",
      });
      expect((yield* setup.read).case.ownerRef).toBe(reference(2));
      expect((yield* setup.read).case.revision).toBe(0);
      yield* Effect.sync(() => database.exec("DROP TRIGGER fail_history"));
      const completed = yield* setup.submit(command);
      expect(completed.case.revision).toBe(1);
      expect(yield* setup.submit(command)).toEqual(completed);
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);

it.live("refuses symlink and hardlink registers without modifying their original receipt", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    const original = yield* setup.submit(receive("Access"));
    const other = yield* fixture;
    const target = `${other.directory}/register.sqlite`;
    yield* setup.fs.symlink(`${setup.directory}/register.sqlite`, target);
    expect(yield* other.submit(receive("Access")).pipe(Effect.flip)).toMatchObject({
      reason: "UnsafeStorage",
    });
    yield* setup.fs.remove(target);
    yield* setup.fs.link(`${setup.directory}/register.sqlite`, target);
    expect(yield* other.submit(receive("Access")).pipe(Effect.flip)).toMatchObject({
      reason: "UnsafeStorage",
    });
    yield* setup.fs.remove(target);
    expect(yield* setup.read).toEqual(original);
  }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);

it.live("records one notified extension within its cap without moving the original deadline", () =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    yield* setup.submit(receive("Access"));
    const input = {
      action: "Extend",
      caseId,
      commandId: reference(4),
      revision: 0,
      notificationRef: reference(5),
      reasonRef: reference(6),
      responseDate: "2026-10-28",
    } as const;
    expect(yield* setup.submit(input).pipe(Effect.flip)).toMatchObject({
      reason: "InvalidTransition",
    });
    const extended = yield* setup.submit({ ...input, responseDate: "2026-10-27" });
    expect(Option.getOrNull(extended.targets.response)).toBe("2026-10-21");
    expect(Option.getOrNull(extended.case.extension)?.responseDate).toBe("2026-10-27");
    expect(
      yield* setup
        .submit({ ...input, commandId: reference(7), revision: 1, responseDate: "2026-10-27" })
        .pipe(Effect.flip)
    ).toMatchObject({ reason: "InvalidTransition" });
  }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);

it.live(
  "the operator command bounds stdin and exposes neither rejected personal fields nor storage details",
  () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const inputs = ["x".repeat(4097), '{"operation":"Apply","email":"private@example.test"}'];
      for (const input of inputs) {
        const result = yield* Effect.sync(() =>
          Bun.spawnSync(
            [process.execPath, new URL("./main.ts", import.meta.url).pathname, setup.directory],
            { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" }
          )
        );
        expect(result.exitCode).toBe(1);
        expect(new TextDecoder().decode(result.stderr)).toBe('{"error":"InvalidInput"}\n');
        expect(new TextDecoder().decode(result.stdout)).toBe("");
      }
      expect(yield* setup.fs.exists(`${setup.directory}/register.sqlite`)).toBe(false);
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);
