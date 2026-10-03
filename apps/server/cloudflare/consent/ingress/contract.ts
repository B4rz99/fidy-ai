/** Pre-User Consent work is reached only after the WhatsApp owner authenticates exact inbound bytes. */
export type ConsentIngressEnvironment = Readonly<{
  DB: D1Database;
  KAPSO_API_KEY: string;
  onAccepted: (id: string) => void;
}>;
