import { DateTime, Effect, Match, Option } from "effect";
import { type CaseCommand, RegisterFailure, TitularCase } from "./contract";
import { caseDeadlines, parseDate } from "./calendar";

const bogotaZone = DateTime.zoneMakeNamedUnsafe("America/Bogota");
const localDate = (atMs: number): string =>
  DateTime.formatIsoDate(DateTime.setZone(DateTime.makeUnsafe(atMs), bogotaZone));
const refuse = (): Effect.Effect<never, RegisterFailure> =>
  Effect.fail(new RegisterFailure({ reason: "InvalidTransition" }));
type TransitionCommand = Exclude<CaseCommand, { action: "Receive" }>;
type CaseTransition<Command = TransitionCommand> = Readonly<{
  current: TitularCase;
  command: Command;
  atMs: number;
}>;
type ResolutionCommand = Extract<
  CaseCommand,
  { action: "RecordOwnerResult" | "RecordWithdrawal" | "ReferErasure" | "PrepareResponse" }
>;
type AdministrativeCommand = Extract<
  CaseCommand,
  { action: "Assign" | "RequestCompletion" | "RecordCompletion" | "RecordVerification" }
>;

const receive = (
  input: Readonly<{ command: Extract<CaseCommand, { action: "Receive" }>; atMs: number }>
): Effect.Effect<TitularCase, RegisterFailure> => {
  const date = DateTime.make(input.command.receivedAtMs);
  if (Option.isNone(date) || input.command.receivedAtMs > input.atMs) return refuse();
  return Effect.succeed(
    TitularCase.make({
      caseId: input.command.caseId,
      kind: input.command.kind,
      requester: input.command.requester,
      requestRef: input.command.requestRef,
      scopeRef: input.command.scopeRef,
      ownerRef: input.command.ownerRef,
      revision: 0,
      receivedAtMs: input.command.receivedAtMs,
      receivedDate: localDate(input.command.receivedAtMs),
      updatedAtMs: input.atMs,
      completion: Option.none(),
      completed: Option.none(),
      verificationRef: Option.none(),
      ownerResultRef: Option.none(),
      withdrawalRef: Option.none(),
      erasureHandoffRef: Option.none(),
      delivery: { status: "NotPrepared" },
      extension: Option.none(),
    })
  );
};

const extend = ({
  current,
  command,
  atMs,
}: Readonly<{
  current: TitularCase;
  command: Extract<CaseCommand, { action: "Extend" }>;
  atMs: number;
}>): Effect.Effect<TitularCase, RegisterFailure> => {
  const targets = caseDeadlines(current);
  if (
    Option.isSome(current.extension) ||
    Option.isNone(targets.response) ||
    Option.isNone(targets.maximumExtension)
  ) {
    return refuse();
  }
  if (
    localDate(atMs) > targets.response.value ||
    Option.isNone(parseDate(command.responseDate)) ||
    command.responseDate <= targets.response.value ||
    command.responseDate > targets.maximumExtension.value
  ) {
    return refuse();
  }
  return Effect.succeed({
    ...current,
    extension: Option.some({
      notificationRef: command.notificationRef,
      reasonRef: command.reasonRef,
      responseDate: command.responseDate,
    }),
  });
};

const prepareResponse = (
  current: TitularCase,
  evidenceRef: string
): Effect.Effect<TitularCase, RegisterFailure> => {
  const required: Readonly<Record<TitularCase["kind"], Option.Option<string>>> = {
    Access: current.ownerResultRef,
    AuthorizationProof: current.ownerResultRef,
    UseExplanation: current.ownerResultRef,
    Correction: current.ownerResultRef,
    Complaint: current.ownerResultRef,
    Withdrawal: current.withdrawalRef,
    Erasure: current.erasureHandoffRef,
  };
  if (Option.isNone(current.verificationRef) || Option.isNone(required[current.kind])) {
    return refuse();
  }
  return Effect.succeed({ ...current, delivery: { status: "Pending", responseRef: evidenceRef } });
};

const recordDelivery = (
  input: Readonly<{
    current: TitularCase;
    command: Extract<
      CaseCommand,
      { action: "DeliveryFailed" | "DeliveryUncertain" | "RecordResponse" }
    >;
  }>
): Effect.Effect<TitularCase, RegisterFailure> => {
  const { current, command } = input;
  if (current.delivery.status === "NotPrepared" || Option.isNone(current.verificationRef)) {
    return refuse();
  }
  const status = {
    RecordResponse: "Confirmed",
    DeliveryFailed: "Failed",
    DeliveryUncertain: "Uncertain",
  } as const;
  return Effect.succeed({
    ...current,
    delivery: {
      status: status[command.action],
      responseRef: current.delivery.responseRef,
      evidenceRef: command.evidenceRef,
    },
  });
};

const recordResolution = ({
  current,
  command,
}: CaseTransition<ResolutionCommand>): Effect.Effect<TitularCase, RegisterFailure> => {
  if (Option.isNone(current.verificationRef)) return refuse();
  switch (command.action) {
    case "RecordOwnerResult":
      return Effect.succeed({ ...current, ownerResultRef: Option.some(command.evidenceRef) });
    case "RecordWithdrawal":
      return ["Withdrawal", "Erasure"].includes(current.kind)
        ? Effect.succeed({ ...current, withdrawalRef: Option.some(command.evidenceRef) })
        : refuse();
    case "ReferErasure":
      return current.kind === "Erasure"
        ? Effect.succeed({ ...current, erasureHandoffRef: Option.some(command.evidenceRef) })
        : refuse();
    case "PrepareResponse":
      return prepareResponse(current, command.evidenceRef);
  }
};

const recordAdministrative = ({
  current,
  command,
  atMs,
}: CaseTransition<AdministrativeCommand>): Effect.Effect<TitularCase, RegisterFailure> => {
  switch (command.action) {
    case "Assign":
      return Effect.succeed({ ...current, ownerRef: command.ownerRef });
    case "RequestCompletion":
      return Effect.succeed({
        ...current,
        completion: Option.some({ evidenceRef: command.evidenceRef, requestedAtMs: atMs }),
      });
    case "RecordCompletion":
      return Effect.succeed({
        ...current,
        completed: Option.some({ evidenceRef: command.evidenceRef, completedAtMs: atMs }),
      });
    case "RecordVerification":
      return Effect.succeed({ ...current, verificationRef: Option.some(command.evidenceRef) });
  }
};
const recordTransition = (input: CaseTransition): Effect.Effect<TitularCase, RegisterFailure> =>
  Match.value(input.command).pipe(
    Match.discriminatorsExhaustive("action")({
      Assign: (command) => recordAdministrative({ ...input, command }),
      RequestCompletion: (command) => recordAdministrative({ ...input, command }),
      RecordCompletion: (command) => recordAdministrative({ ...input, command }),
      RecordVerification: (command) => recordAdministrative({ ...input, command }),
      RecordOwnerResult: (command) => recordResolution({ ...input, command }),
      RecordWithdrawal: (command) => recordResolution({ ...input, command }),
      ReferErasure: (command) => recordResolution({ ...input, command }),
      PrepareResponse: (command) => recordResolution({ ...input, command }),
      Extend: (command) => extend({ ...input, command }),
      DeliveryFailed: (command) => recordDelivery({ ...input, command }),
      DeliveryUncertain: (command) => recordDelivery({ ...input, command }),
      RecordResponse: (command) => recordDelivery({ ...input, command }),
    })
  );

const currentRevision = ({
  previous,
  command,
}: Readonly<{ previous: Option.Option<TitularCase>; command: TransitionCommand }>): Effect.Effect<
  TitularCase,
  RegisterFailure
> => {
  if (
    Option.isNone(previous) ||
    previous.value.caseId !== command.caseId ||
    previous.value.revision !== command.revision
  ) {
    return Effect.fail(new RegisterFailure({ reason: "Conflict" }));
  }
  return Effect.succeed(previous.value);
};

/** Records a manual workflow fact only. Evidence references never authorize access, withdrawal, disclosure or erasure. */
export const applyCaseCommand = Effect.fn(function* (
  input: Readonly<{ command: CaseCommand; previous: Option.Option<TitularCase>; atMs: number }>
) {
  const { command, previous, atMs } = input;
  if (command.action === "Receive") {
    return yield* Option.isSome(previous)
      ? Effect.fail(new RegisterFailure({ reason: "Conflict" }))
      : receive({ command, atMs });
  }
  const current = yield* currentRevision({ previous, command });
  if (atMs < current.updatedAtMs || current.delivery.status === "Confirmed") return yield* refuse();
  const next = yield* recordTransition({ current, command, atMs });
  return { ...next, revision: current.revision + 1, updatedAtMs: atMs };
});
