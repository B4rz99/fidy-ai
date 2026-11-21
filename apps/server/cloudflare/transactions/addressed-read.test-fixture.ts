import { Option } from "effect";
import { UserStore as ProductionUserStore } from "../core-worker";
import { presentationQuery } from "./internal/transaction-history";

export { default } from "../core-worker";

export * from "../core-worker";

export class UserStore extends ProductionUserStore {
  override fetch(request: Request): Promise<Response> {
    if (request.url !== "https://fixture.invalid/addressed-cost") return super.fetch(request);
    const userId = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM users").one().id;

    const query = presentationQuery({
      userId,
      id: "20000000-0000-4000-8000-000000000002",
      authority: Option.none(),
    });

    const cursor = this.ctx.storage.sql.exec(query.sql, ...query.bindings);
    const records = cursor.toArray().length;

    return Promise.resolve(Response.json({ records, rowsRead: cursor.rowsRead }));
  }
}
