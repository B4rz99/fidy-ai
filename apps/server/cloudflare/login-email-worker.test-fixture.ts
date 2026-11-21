import { Directory as ProductionDirectory, UserStore as ProductionUserStore } from "./core-worker";
import { bootstrapCompleteUrl, registerSessionUrl } from "./directory/contract";
import { loginAllowanceUrl, loginVerifyUrl } from "./email-authentication/contract";

export { default } from "./core-worker";

export * from "./core-worker";

const revokeUrl = "https://fixture.invalid/revoke-mailbox";

export class UserStore extends ProductionUserStore {
  override fetch(request: Request): Promise<Response> {
    if (
      request.url === bootstrapCompleteUrl &&
      this.ctx.storage.sql
        .exec("SELECT 1 FROM sqlite_schema WHERE name='lose_provider_completion_reply'")
        .toArray().length > 0
    ) {
      this.ctx.storage.sql.exec("DROP TABLE lose_provider_completion_reply");

      return Promise.reject(new Error("Fixture lost the provider completion reply"));
    }

    return this.loginRequest(request);
  }
  private loginRequest(request: Request): Promise<Response> {
    if (request.url === "https://user.invalid/browser/redeem") {
      const storage = this.ctx.storage;
      const sql = storage.sql;

      if (
        sql.exec("SELECT 1 FROM sqlite_schema WHERE name='lose_session_commit_ack'").toArray()
          .length > 0
      ) {
        const transaction = storage.transaction.bind(storage);
        storage.transaction = <Value>(
          callback: (txn: DurableObjectTransaction) => Promise<Value>
        ): Promise<Value> =>
          transaction(callback).then((result) => {
            if (
              sql.exec("SELECT 1 FROM sqlite_schema WHERE name='lose_session_commit_ack'").toArray()
                .length > 0 &&
              sql
                .exec(
                  "SELECT 1 FROM browser_handoffs h JOIN web_sessions s ON s.id=h.claim_id WHERE h.state='consumed'"
                )
                .toArray().length > 0
            ) {
              sql.exec("DROP TABLE lose_session_commit_ack");
              throw new Error("Fixture dropped the activation commit acknowledgement");
            }

            return result;
          });

        return super.fetch(request).finally(() => {
          Reflect.deleteProperty(storage, "transaction");
        });
      }
    }

    if (request.url === loginVerifyUrl) {
      const sql = this.ctx.storage.sql;

      if (sql.exec("SELECT 1 FROM sqlite_schema WHERE name='hash_deadline'").toArray().length > 0) {
        const { deadline } = sql
          .exec<{ deadline: number }>("SELECT expires_at_ms AS deadline FROM login_email_proofs")
          .one();

        const originalNow = Date.now;
        const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
        let current = deadline - 1;
        Date.now = (): number => current;
        crypto.subtle.digest = (algorithm, bytes): Promise<ArrayBuffer> =>
          originalDigest(algorithm, bytes).then((result) => {
            current = deadline;
            sql.exec("INSERT INTO hash_deadline VALUES(?)", current);

            return result;
          });

        return super.fetch(request).finally(() => {
          Date.now = originalNow;
          Reflect.deleteProperty(crypto.subtle, "digest");
        });
      }
    }

    if (request.url !== revokeUrl) return super.fetch(request);
    this.ctx.storage.sql.exec("UPDATE verified_email_credentials SET revision=revision+1");

    return Promise.resolve(new Response(null, { status: 204 }));
  }
}

export class Directory extends ProductionDirectory {
  override fetch(request: Request): Promise<Response> {
    const sql = this.ctx.storage.sql;
    const handled = super.fetch(request);

    if (request.url === registerSessionUrl) {
      return handled.then((reply) => {
        if (
          reply.ok &&
          sql.exec("SELECT 1 FROM sqlite_schema WHERE name='lose_registration_ack'").toArray()
            .length > 0
        ) {
          sql.exec("DROP TABLE lose_registration_ack");
          throw new Error("Fixture dropped a committed registration reply");
        }

        return reply;
      });
    }

    return handled.then((reply) => {
      if (request.url !== loginAllowanceUrl || !reply.ok) return reply;

      const [fault] = sql
        .exec(
          "SELECT name FROM sqlite_schema WHERE name IN ('lose_next_allowance','revoke_on_allowance')"
        )
        .toArray();

      if (fault?.name === "lose_next_allowance") {
        sql.exec("DROP TABLE lose_next_allowance");
        throw new Error("Fixture dropped a committed allowance reply");
      }

      if (fault?.name === "revoke_on_allowance") {
        const user = sql.exec<{ user_id: string }>("SELECT user_id FROM revoke_on_allowance").one();
        sql.exec("DROP TABLE revoke_on_allowance");

        return this.env.USER_STORE.getByName(user.user_id)
          .fetch(revokeUrl, { method: "POST" })
          .then(() => reply);
      }

      return reply;
    });
  }
}
