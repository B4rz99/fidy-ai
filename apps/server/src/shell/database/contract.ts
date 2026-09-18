/**
 * A namespaced PostgreSQL advisory-lock identity. Callers obtain keys from the database
 * operations interface so unrelated resources cannot accidentally share a lock.
 */
export type AdvisoryLockKey = {
  readonly value: string;
  readonly seed: number;
};

/** The bounded authority facts needed while provisioning the fixed runtime role. */
export type RuntimeRoleStatus = {
  readonly canLogin: boolean;
  readonly hasUnsafeAuthority: boolean;
};
