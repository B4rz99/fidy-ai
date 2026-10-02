/** Private composition behind the origin-checked browser boundary; input still needs owner proof validation. */
export type OnboardingRequest = Readonly<{ request: Request; db: D1Database }>;
