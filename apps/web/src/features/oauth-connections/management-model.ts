import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { OAuthConnectionId, OAuthConnectionList } from "@/transport/client";

export const Model = Schema.Struct({
  list: Schema.Option(OAuthConnectionList),
  status: Schema.Literals(["Loading", "Ready", "Failed", "Revoking"]),
  revocation: Schema.Literals(["None", "Succeeded", "Uncertain"]),
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  Loaded: { list: OAuthConnectionList },
  LoadFailed: {},
  ClickedRefresh: {},
  ClickedRevoke: { id: Schema.Option(OAuthConnectionId) },
  Revoked: {},
  RevocationUncertain: {},
});
export type Message = typeof Message.Type;
