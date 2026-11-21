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

type CorrectionCall = Readonly<{
  callId: string;
  operation: "transactions.updateTransaction";
  input: Readonly<{ params: Readonly<{ id: string }>; payload: unknown }>;
}>;

export const correctionCall: {
  (id: string, payload: unknown): (suffix: number) => CorrectionCall;
  (suffix: number, id: string, payload: unknown): CorrectionCall;
} = Function.dual(3, (suffix: number, id: string, payload: unknown): CorrectionCall => ({
  callId: batchCallId(suffix),
  operation: "transactions.updateTransaction",
  input: { params: { id }, payload },
}));
