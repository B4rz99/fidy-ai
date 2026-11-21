import { UserStore as ProductionUserStore } from "./core-worker";

export { default } from "./core-worker";

export * from "./core-worker";

export class UserStore extends ProductionUserStore {
  override fetch(request: Request): Promise<Response> {
    if (
      this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE name='fixture_clock'").toArray()
        .length === 0
    ) {
      return super.fetch(request);
    }

    const { instant } = this.ctx.storage.sql
      .exec<{ instant: number }>("SELECT instant FROM fixture_clock")
      .one();

    const live = Date.now;
    Date.now = (): number => instant;

    return super.fetch(request).finally(() => {
      Date.now = live;
    });
  }
}
