import { IssuedPAT } from "@fidy/server/client";
import { Schema, Struct } from "effect";

const PAT = IssuedPAT.fields.pat;

const PATFields = Schema.toCodecJson(PAT.mapFields(Struct.omit(["_tag"])));

type IssuedPATInput = Readonly<{ bearer: string; pat: typeof PATFields.Encoded }>;

export const decodePAT = (fields: typeof PATFields.Encoded): IssuedPAT["pat"] =>
  PAT.make(Schema.decodeSync(PATFields)(fields));

export const decodeIssuedPAT = ({ bearer, pat }: IssuedPATInput): IssuedPAT =>
  IssuedPAT.make({
    bearer: Schema.decodeSync(IssuedPAT.fields.bearer)(bearer),
    pat: decodePAT(pat),
  });
