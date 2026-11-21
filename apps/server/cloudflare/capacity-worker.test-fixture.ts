import { UserStore as NativeUserStore } from "./core-worker";

export { default } from "./core-worker";

export * from "./core-worker";

export class UserStore extends NativeUserStore {
  override fetch(request: Request): Promise<Response> {
    if (request.url === "https://fixture.invalid/database-size") {
      return Promise.resolve(Response.json(this.ctx.storage.sql.databaseSize));
    }

    return super.fetch(request);
  }
}
