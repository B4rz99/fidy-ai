import { UserStore as NativeUser } from "../core-worker";

export { default } from "../core-worker";

export * from "../core-worker";

export class UserStore extends NativeUser {
  override fetch(request: Request): Promise<Response> {
    return super.fetch(request).then((response) => {
      if (
        this.ctx.storage.sql
          .exec("SELECT 1 FROM sqlite_schema WHERE name='lose_read_reply'")
          .toArray().length > 0 &&
        this.ctx.storage.sql
          .exec(
            "DELETE FROM lose_read_reply WHERE path=? RETURNING path",
            new URL(request.url).pathname
          )
          .toArray().length > 0
      ) {
        return response.arrayBuffer().then(() => {
          throw new Error("Synthetic response lost after owner commit");
        });
      }

      return response;
    });
  }
}
