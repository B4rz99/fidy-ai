export const verifyReleaseTransaction = (storage: DurableObjectStorage): Response => {
  const { sql } = storage;
  const rollback = new Error("Expected release probe rollback");
  storage.transactionSync(() => {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS fidy_release_probe(id INTEGER PRIMARY KEY, value INTEGER NOT NULL) STRICT"
    );
    sql.exec("INSERT INTO fidy_release_probe VALUES (1,1) ON CONFLICT(id) DO UPDATE SET value=1");
  });

  try {
    storage.transactionSync(() => {
      const changed = sql
        .exec<{ value: number }>("UPDATE fidy_release_probe SET value=2 WHERE id=1 RETURNING value")
        .one();

      if (changed.value !== 2) throw new Error("Release write unavailable");
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }

  storage.transactionSync(() => {
    const saved = sql
      .exec<{ value: number }>("SELECT value FROM fidy_release_probe WHERE id=1")
      .one();

    if (saved.value !== 1) throw new Error("Release transaction failed");
    sql.exec("DROP TABLE fidy_release_probe");
  });

  return new Response(null, { status: 204 });
};
