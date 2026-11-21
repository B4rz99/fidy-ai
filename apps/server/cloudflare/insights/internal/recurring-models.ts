import { Schema } from "effect";
import { RecurringDigestReport } from "../../../src/core/insights/contract";

export const maximumItems = 128;

export const ReportJson = Schema.fromJsonString(Schema.toCodecJson(RecurringDigestReport));
