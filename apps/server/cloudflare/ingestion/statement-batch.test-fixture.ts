import { Function, Schema } from "effect";

export const BatchEnvelope = Schema.Struct({
  data: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        operation: Schema.String,
        output: Schema.Unknown,
      })
    ),
  }),
  next: Schema.Array(Schema.Unknown),
});

const batchCallIdDigits = 12;

export const batchCallId = (suffix: number): string =>
  `20000000-0000-4000-8000-${String(suffix).padStart(batchCallIdDigits, "0")}`;

export const correctionCall: {
  (id: string, payload: object): (suffix: number) => object;
  (suffix: number, id: string, payload: object): object;
} = Function.dual(3, (suffix: number, id: string, payload: object): object => ({
  callId: batchCallId(suffix),
  operation: "transactions.updateTransaction",
  input: { params: { id }, payload },
}));
