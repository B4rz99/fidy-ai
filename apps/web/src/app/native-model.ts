import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";
import { AppRoute } from "./native-routes";

export const Authentication = Schema.Literals(["signed-out", "signed-in", "expired"]);
export type Authentication = typeof Authentication.Type;
export const Model = Schema.Struct({
  route: AppRoute,
  authentication: Authentication,
  epoch: Schema.Int,
  logout: Schema.Literals(["Idle", "Pending", "Failed"]),
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  RequestedUrl: { request: UrlRequest },
  ChangedUrl: { url: Url },
  ChangedLifetime: { authentication: Authentication, epoch: Schema.Int },
  ClickedLogout: {},
  FailedLogout: { epoch: Schema.Int },
  Completed: {},
  Mounted: {},
});
export type Message = typeof Message.Type;
