export const externalRoutesSchema = (): ReadonlyArray<string> =>
  [
    `CREATE TABLE external_event_routes(kind TEXT NOT NULL,endpoint TEXT NOT NULL,lookup TEXT NOT NULL,
    user_id TEXT NOT NULL,operation_id TEXT NOT NULL,family TEXT NOT NULL,
    PRIMARY KEY(kind,endpoint,lookup), UNIQUE(user_id,family,operation_id)) STRICT`,
  ] as const;
