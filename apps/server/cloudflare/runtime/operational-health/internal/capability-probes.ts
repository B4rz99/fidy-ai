import { Schema } from "effect";

export const Available = Schema.Struct({ usable: Schema.Literal(1) });
export const probeUrl = "https://internal.invalid/operational/probe";
export const probeSuccessStatus = 204;
