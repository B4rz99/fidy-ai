import { offerChannel } from "./internal/local-channel-delivery";
import { hostedDocument, hostedText } from "./internal/local-whatsapp";
import { inspectTurns, recoverTurns } from "./internal/local-recovery";
import { browserHosted, browserHostedPaths } from "./internal/local-hosted";

export const isLocalHostedPath = (path: string): boolean => browserHostedPaths.includes(path);

export const handleLocalHosted: typeof browserHosted = (...args) => browserHosted(...args);

export const repairLocalHostedAlarm: typeof inspectTurns = (...args) => inspectTurns(...args);

export const recoverLocalHosted: typeof recoverTurns = (...args) => recoverTurns(...args);

export const admitLocalHostedDocument: typeof hostedDocument = (...args) => hostedDocument(...args);

export const acceptLocalHostedText: typeof hostedText = (...args) => hostedText(...args);

export const offerLocalHostedReply: typeof offerChannel = (...args) => offerChannel(...args);
