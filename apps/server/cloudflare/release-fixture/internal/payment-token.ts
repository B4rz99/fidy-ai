/** The closed payment fixture binds each instrument to the ordinal of its predeclared synthetic subject. */
export const acceptancePaymentToken = ({
  kind,
  subject,
}: Readonly<{ kind: "CARD" | "NEQUI"; subject: string }>): string =>
  [
    kind === "CARD" ? "tok" : "nequi",
    "test",
    "fidy",
    "acceptance",
    subject.slice(subject.lastIndexOf("-") + 1),
  ].join("_");
