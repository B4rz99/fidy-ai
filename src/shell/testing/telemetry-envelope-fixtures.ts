import { Option, Schema } from "effect";
import { ProjectedErrorEvent, ProjectedTransaction } from "~/shell/observability/projectors";

/** One decoded header/payload pair from a serialized Sentry envelope fixture. */
export type DecodedEnvelopeItem = Readonly<{
  readonly header: unknown;
  readonly payload: unknown;
}>;

/** Decodes complete item pairs while ignoring the envelope header line. */
export const decodeEnvelopeItems = (bytes: Uint8Array): ReadonlyArray<DecodedEnvelopeItem> => {
  const lines = new TextDecoder().decode(bytes).split("\n");
  const items: Array<DecodedEnvelopeItem> = [];
  for (let index = 1; index + 1 < lines.length; index += 2) {
    items.push({
      header: Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(lines[index] ?? "null"),
      payload: Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(lines[index + 1] ?? "null"),
    });
  }
  return items;
};

/** Strictly extracts every payload admitted by one projected telemetry schema. */
const envelopePayloadsOf = <Decoded, Encoded>(
  schema: Schema.Codec<Decoded, Encoded>,
  envelopes: ReadonlyArray<Uint8Array>
): ReadonlyArray<Decoded> =>
  envelopes
    .flatMap(decodeEnvelopeItems)
    .flatMap(({ payload }) => Option.toArray(Schema.decodeUnknownOption(schema)(payload)));

/** Extracts transaction payloads from complete serialized envelopes. */
export const transactionEnvelopePayloads = (
  envelopes: ReadonlyArray<Uint8Array>
): ReadonlyArray<ProjectedTransaction> => envelopePayloadsOf(ProjectedTransaction, envelopes);

/** Extracts error payloads from complete serialized envelopes. */
export const errorEnvelopePayloads = (
  envelopes: ReadonlyArray<Uint8Array>
): ReadonlyArray<ProjectedErrorEvent> => envelopePayloadsOf(ProjectedErrorEvent, envelopes);
