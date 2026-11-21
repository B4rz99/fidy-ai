import { EmailVerificationCode } from "@/transport/client";
import { type Option, Schema } from "effect";

const separators = /[\s-]/gu;
const groups = /.{1,4}/gu;

export const readEmailVerificationCode = (input: string): Option.Option<EmailVerificationCode> =>
  Schema.decodeOption(EmailVerificationCode)(
    (input.replace(separators, "").toUpperCase().match(groups) ?? []).join("-")
  );
