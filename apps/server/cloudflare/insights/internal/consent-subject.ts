import { Data } from "effect";
import type { ConsentSubject as Subject } from "../../../src/shell/consent/contract";

export const ConsentSubject = Data.taggedEnum<Subject>();
