import { Directory as ProductionDirectory, UserStore as ProductionUserStore } from "./core-worker";
import { loginAllowanceUrl } from "./email-authentication/contract";

export { default } from "./core-worker";
export * from "./core-worker";

const revokeUrl = "https://fixture.invalid/revoke-mailbox";
export class UserStore extends ProductionUserStore {
  override fetch(request: Request): Promise<Response> {
    if (request.url !== revokeUrl) return super.fetch(request);
    this.ctx.storage.sql.exec("UPDATE verified_email_credentials SET revision=revision+1");
    return Promise.resolve(new Response(null, { status: 204 }));
  }
}

export class Directory extends ProductionDirectory {
  override fetch(request: Request): Promise<Response> {
    return super.fetch(request).then((reply) => {
      if (request.url !== loginAllowanceUrl || !reply.ok) return reply;
      const sql = this.ctx.storage.sql;
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
