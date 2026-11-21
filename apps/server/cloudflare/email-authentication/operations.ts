import {
  activateMailbox as nativeActivateMailbox,
  mailboxProof as nativeMailboxProof,
} from "./internal/local-mailbox";
import {
  repairReplacementAlarm as nativeRepairReplacementAlarm,
  replacementRequest as nativeReplacementRequest,
} from "./internal/local-replacement";

export const activateMailbox: typeof nativeActivateMailbox = (...args) =>
  nativeActivateMailbox(...args);

export const mailboxProof: typeof nativeMailboxProof = (...args) => nativeMailboxProof(...args);

export const repairReplacementAlarm: typeof nativeRepairReplacementAlarm = (...args) =>
  nativeRepairReplacementAlarm(...args);

export const replacementRequest: typeof nativeReplacementRequest = (...args) =>
  nativeReplacementRequest(...args);
