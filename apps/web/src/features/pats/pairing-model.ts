import { Option, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { PATPairingPublicCode, PATPairingReview } from "@/transport/client";

export const PairingModel = Schema.Struct({
  status: Schema.Literals([
    "Entering",
    "Inspecting",
    "Reviewing",
    "Approving",
    "Invalid",
    "Approved",
  ]),
  publicCode: Schema.Option(PATPairingPublicCode),
  review: Schema.Option(PATPairingReview),
  hasDraft: Schema.Boolean,
});
export type PairingModel = typeof PairingModel.Type;
export const emptyPairing: PairingModel = {
  status: "Entering",
  publicCode: Option.none(),
  review: Option.none(),
  hasDraft: false,
};
export const PairingMessage = defineMessageUnion({
  EditedCode: { hasDraft: Schema.Boolean },
  RequestedInspection: {},
  Inspected: { review: PATPairingReview, publicCode: PATPairingPublicCode },
  InspectionFailed: { publicCode: Schema.Option(PATPairingPublicCode) },
  RequestedApproval: {},
  Approved: {},
  ApprovalFailed: {},
  Reset: {},
  Mounted: {},
});
export type PairingMessage = typeof PairingMessage.Type;
