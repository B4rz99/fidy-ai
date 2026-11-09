import { Option, Schema } from "effect";
import { ErasureReference } from "../../../src/core/erasure/contract";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { ErasureGeneration } from "../contract";
import { RecoveryCase } from "./recovery-case";
import { generationKey } from "./generation";

const casesPrefix = "recovery/cases/";
const maximumGenerationBytes = 64;
const maximumCaseBytes = 512;
const encoder = new TextEncoder();
const decode = <Value extends Schema.ConstraintDecoder<unknown>>(
  schema: Value,
  value: unknown
): Value["Type"] => {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value);
  if (Option.isNone(decoded)) throw new ErasureUnavailable();
  return decoded.value;
};
export const checkRegistryKey = (key: string): void => {
  if (key === generationKey) return;
  if (!key.startsWith(casesPrefix)) throw new ErasureUnavailable();
  decode(ErasureReference, key.slice(casesPrefix.length));
};
export const checkRegistryValue = (input: Readonly<{ key: string; value: string }>): void => {
  const { key, value } = input;
  if (key === generationKey) {
    if (encoder.encode(value).byteLength > maximumGenerationBytes) throw new ErasureUnavailable();
    if (value.startsWith("publishing:")) {
      decode(ErasureReference, value.slice("publishing:".length));
    } else {
      decode(ErasureGeneration, value);
    }
    return;
  }
  if (encoder.encode(value).byteLength > maximumCaseBytes) throw new ErasureUnavailable();
  const record = decode(Schema.fromJsonString(RecoveryCase), value);
  if (key !== `${casesPrefix}${record.reference}`) throw new ErasureUnavailable();
};
