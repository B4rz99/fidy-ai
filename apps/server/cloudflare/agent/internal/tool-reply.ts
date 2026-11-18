import { Option, Schema } from "effect";
import { type CanonicalToolOutcome, TranscriptText } from "../../../src/core/agent/contract";
import { ConnectInstitutionResult } from "../../../src/core/connections/contract";
import { operationCatalog } from "../../../src/shell/api";
import type { HostedContinuationEvent } from "../../../src/shell/hosted-inference/contract";
import { transactionReceipt } from "./capture-reply";

type HostedToolEvent = Extract<HostedContinuationEvent, { readonly _tag: "ToolResult" }>;
export type HostedToolAction =
  | Readonly<{ _tag: "Result"; event: HostedToolEvent; mutationSucceeded: boolean }>
  | Readonly<{ _tag: "Challenge"; text: TranscriptText }>;
const queryAbsence = Schema.Struct({ error: Schema.Struct({ code: Schema.Literal("not_found") }) });
const confirmedQueryResult = (outcome: CanonicalToolOutcome): boolean =>
  outcome._tag === "Succeeded" ||
  (outcome._tag === "CanonicalOperationFailed" && Schema.is(queryAbsence)(outcome.failure));

/** A rejected read supplies no data from which the model may infer an empty result. */
export const failedQueryReply = (
  actions: ReadonlyArray<HostedToolAction>
): Option.Option<TranscriptText> =>
  actions.some(
    (action) =>
      action._tag === "Result" &&
      operationCatalog.byId.get(action.event.operation)?.policy.kind === "query" &&
      !confirmedQueryResult(action.event.outcome)
  )
    ? Option.some(
        TranscriptText.make(
          "No pude completar la consulta solicitada. No puedo confirmar sus resultados. Inténtalo de nuevo."
        )
      )
    : Option.none();

const toolReceipt = (action: HostedToolAction, timeZone: string): Option.Option<TranscriptText> => {
  if (action._tag !== "Result" || action.event.outcome._tag !== "Succeeded") return Option.none();
  if (action.event.operation === "connections.connectInstitution") {
    const result = Schema.decodeUnknownOption(Schema.Struct({ data: ConnectInstitutionResult }))(
      action.event.outcome.output
    );
    if (Option.isSome(result) && result.value.data.type === "continue_in_browser") {
      return Option.some(
        TranscriptText.make(
          "Para autorizar la conexión, abre " + result.value.data.continuation.url
        )
      );
    }
  }
  return transactionReceipt({
    operation: action.event.operation,
    output: action.event.outcome.output,
    timeZone,
  });
};

/** A completed canonical write never licenses an unqualified success for other failed calls. */
export const committedAnswer = ({
  actions,
  timeZone,
}: {
  actions: Option.Option<ReadonlyArray<HostedToolAction>>;
  timeZone: string;
}): TranscriptText => {
  if (Option.isNone(actions)) {
    return TranscriptText.make(
      "Una operación se completó; el estado de las demás no está confirmado."
    );
  }
  const partial = actions.value.some(
    (action) =>
      action._tag === "Result" &&
      action.event.outcome._tag !== "Succeeded" &&
      action.event.outcome._tag !== "CommittedOutputUnavailable"
  );
  if (!partial) {
    for (const action of actions.value) {
      const receipt = toolReceipt(action, timeZone);
      if (Option.isSome(receipt)) return receipt.value;
    }
  }
  return TranscriptText.make(
    partial
      ? "Completé una parte de lo que pediste. Quedaron cambios sin hacer."
      : "Listo, apliqué los cambios."
  );
};
