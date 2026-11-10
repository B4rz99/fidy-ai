import { Option, Schema } from "effect";
import { BrowserSessionBindingSchema } from "@/transport/client";

const StoredAdmission = Schema.Struct({
  version: Schema.Literal(1),
  binding: BrowserSessionBindingSchema.fields.binding,
});
const storedAdmission = Schema.fromJsonString(StoredAdmission);
const key = "fidy:email-replacement-admission-v1";
const maximumCharacters = 128;

export const retainReplacementAdmission = (binding: string): boolean => {
  const admission = Schema.decodeOption(StoredAdmission)({ version: 1, binding });
  if (Option.isNone(admission)) return false;
  try {
    const encoded = Schema.encodeSync(storedAdmission)(admission.value);
    window.sessionStorage.setItem(key, encoded);
    return window.sessionStorage.getItem(key) === encoded;
  } catch {
    return false;
  }
};

export const restoreReplacementAdmission = (
  binding: string
): "clear" | "uncertain" | "unavailable" => {
  if (Option.isNone(Schema.decodeOption(StoredAdmission)({ version: 1, binding }))) {
    return "unavailable";
  }
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return "clear";
    const decoded =
      raw.length <= maximumCharacters
        ? Schema.decodeOption(storedAdmission, { onExcessProperty: "error" })(raw)
        : Option.none();
    if (Option.isNone(decoded)) {
      return "unavailable";
    }
    if (decoded.value.binding === binding) return "uncertain";
    return "clear";
  } catch {
    return "unavailable";
  }
};

export const clearReplacementAdmission = (binding: string): void => {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null || raw.length > maximumCharacters) return;
    const decoded = Schema.decodeOption(storedAdmission, { onExcessProperty: "error" })(raw);
    if (Option.isSome(decoded) && decoded.value.binding === binding) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    return undefined;
  }
};
