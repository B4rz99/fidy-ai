/** Stable inventory used by the WhatsApp acceptance release signal. */
export const whatsappAcceptanceScenarios = {
  "WA-A01": "A new sandbox caller receives the disclosure",
  "WA-A02": "Business Portfolio plus BSUID remains authoritative",
  "WA-A03": "Sandbox delivery without phone evidence fails closed",
  "WA-A04": "Consent acceptance establishes the stable User",
  "WA-A05": "A financial message creates one Transaction and reply",
  "WA-A06": "Webhook replay does not duplicate effects",
  "WA-A07": "Definitive provider rejection is safely retryable",
  "WA-A08": "Ambiguous delivery is not automatically replayed",
  "WA-A09": "Missing lifecycle webhook leaves delivery durably ambiguous",
  "WA-A10": "BSUID and sandbox addressing remain mutually exclusive",
} as const;

export type WhatsAppAcceptanceScenarioId = keyof typeof whatsappAcceptanceScenarios;

/** Scenarios executable by the WhatsApp acceptance release signal. */
export const implementedWhatsAppAcceptanceScenarioIds = [
  "WA-A01",
  "WA-A02",
  "WA-A03",
  "WA-A04",
  "WA-A05",
  "WA-A06",
  "WA-A07",
  "WA-A08",
  "WA-A09",
  "WA-A10",
] as const satisfies ReadonlyArray<WhatsAppAcceptanceScenarioId>;

/** Scenario identifiers implemented by this acceptance slice. */
export type ImplementedWhatsAppAcceptanceScenarioId =
  (typeof implementedWhatsAppAcceptanceScenarioIds)[number];

/** Prefixes test output with the stable scenario identifier retained in CI logs. */
export const whatsappAcceptanceTestName = (id: WhatsAppAcceptanceScenarioId): string =>
  `[${id}] ${whatsappAcceptanceScenarios[id]}`;
