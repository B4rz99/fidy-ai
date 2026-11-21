import { SampleReviewCommand, type SampleReviewResult } from "@fidy/server/client";
import { Effect, Option, Redacted, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { CliFailure } from "../credential/contract";

type Command = typeof SampleReviewCommand.Type;

type Result = typeof SampleReviewResult.Type;

export type Reviewer = Readonly<{
  interactive: boolean;
  authenticate: Effect.Effect<
    Redacted.Redacted<string>,
    CliFailure,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  read: (label: string) => Effect.Effect<string, CliFailure>;
  write: (message: string) => Effect.Effect<void>;
  submit: (
    command: Command,
    assertion: Redacted.Redacted<string>
  ) => Effect.Effect<Result, CliFailure>;
}>;

const invalid = (): CliFailure => new CliFailure({ reason: "InvalidInput", cause: Option.none() });

const resultMessage = (result: Result): string => {
  if ("sampleId" in result) {
    return result.status === "published"
      ? `Muestra publicada: ${result.sampleId}\n`
      : `Publicación pendiente: ${result.sampleId}\n`;
  }

  return result.status === "withdrawn" ? "Muestra retirada.\n" : "Candidato rechazado.\n";
};

type Submit = (command: unknown) => Effect.Effect<Result, CliFailure>;

const withdraw = Effect.fn(function* (reviewer: Reviewer, submit: Submit) {
  const sampleId = yield* reviewer.read("Identidad de la muestra publicada: ");

  if ((yield* reviewer.read("Escribe RETIRAR para eliminar la muestra: ")) !== "RETIRAR") {
    return yield* invalid();
  }

  const result = yield* submit({ action: "withdraw", sampleId });

  if (result.status !== "withdrawn") {
    return yield* new CliFailure({ reason: "MutationAmbiguous", cause: Option.none() });
  }

  return yield* reviewer.write(resultMessage(result));
});

const retry = Effect.fn(function* (reviewer: Reviewer, submit: Submit, userId: string) {
  const candidateId = yield* reviewer.read("Identidad del candidato revisado: ");
  const revision = Number(yield* reviewer.read("Revisión aprobada: "));
  const digest = yield* reviewer.read("SHA-256 de la revisión aprobada: ");

  if ((yield* reviewer.read("Escribe APROBAR para confirmar la misma decisión: ")) !== "APROBAR") {
    return yield* invalid();
  }

  const result = yield* submit({ action: "approve", userId, candidateId, revision, digest });

  if (result.status !== "approved" && result.status !== "published") {
    return yield* new CliFailure({ reason: "MutationAmbiguous", cause: Option.none() });
  }

  return yield* reviewer.write(resultMessage(result));
});

const resultMatches = (action: "approve" | "reject", result: Result): boolean =>
  action === "reject"
    ? result.status === "rejected"
    : result.status === "published" || result.status === "approved";

const review = Effect.fn(function* (reviewer: Reviewer, submit: Submit, userId: string) {
  const preview = yield* submit({ action: "preview", userId });

  if (preview.status === "empty") return yield* reviewer.write("Sin candidatos pendientes.\n");

  if (preview.status !== "preview") {
    return yield* new CliFailure({ reason: "TransportUnavailable", cause: Option.none() });
  }

  const artifact = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
    preview.artifact
  ).pipe(Effect.mapError(invalid));

  yield* reviewer.write(
    `Candidato ${preview.candidateId} · revisión ${preview.revision}\nSHA-256 ${preview.digest}\n${artifact}\n`
  );

  const decision = yield* reviewer.read(
    "Verifica que solo contenga estructura anónima. Escribe APROBAR, RECHAZAR o pulsa Intro para salir: "
  );

  if (decision === "") return;

  if (decision !== "APROBAR" && decision !== "RECHAZAR") return yield* invalid();
  const action = decision === "APROBAR" ? "approve" : "reject";

  const result = yield* submit({
    action,
    userId,
    candidateId: preview.candidateId,
    revision: preview.revision,
    digest: preview.digest,
  });

  if (!resultMatches(action, result)) {
    return yield* new CliFailure({ reason: "MutationAmbiguous", cause: Option.none() });
  }

  yield* reviewer.write(resultMessage(result));
});

export const runSampleReview = Effect.fn(function* (
  args: ReadonlyArray<string>,
  reviewer: Reviewer
) {
  const mode = args[1];

  if (
    !reviewer.interactive ||
    args.length !== 2 ||
    args[0] !== "sample-review" ||
    !["review", "withdraw", "retry"].includes(mode ?? "")
  ) {
    return yield* invalid();
  }

  const assertion = yield* reviewer.authenticate;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Redacted.wipeUnsafe(assertion);
    })
  );

  const submit: Submit = (input) =>
    Schema.decodeUnknownEffect(SampleReviewCommand)(input).pipe(
      Effect.mapError(invalid),
      Effect.flatMap((command) => reviewer.submit(command, assertion))
    );

  if (mode === "withdraw") return yield* withdraw(reviewer, submit);
  const userId = yield* reviewer.read("Identidad del titular: ");

  return yield* (mode === "retry" ? retry : review)(reviewer, submit, userId);
}, Effect.scoped);
