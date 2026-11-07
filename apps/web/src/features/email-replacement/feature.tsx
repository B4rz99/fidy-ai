import type { JSX } from "react";
import { useEmailReplacement } from "./controller";
import { EmailReplacementView } from "./view";

export const EmailReplacementFeature = (): JSX.Element => (
  <EmailReplacementView {...useEmailReplacement()} />
);
