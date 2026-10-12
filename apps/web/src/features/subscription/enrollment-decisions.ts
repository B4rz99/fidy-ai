export type EnrollmentDecisions = Readonly<{ endUserPolicy: boolean; personalData: boolean }>;
export const emptyDecisions: EnrollmentDecisions = { endUserPolicy: false, personalData: false };
export const allDecisionsAccepted = (decisions: EnrollmentDecisions): boolean =>
  decisions.endUserPolicy && decisions.personalData;
