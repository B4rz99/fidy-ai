import { repairPATExpiry, sweepPATExpiry } from "./internal/native-expiry";
import {
  dispatchManagement,
  isPATManagement,
  readActivity,
  readMetadata,
} from "./internal/native-management";
import { localClaim } from "./internal/native-claim";
import { dispatchGrant, isNativeGrant, stageGrant } from "./internal/native-grants";
import { directoryPATCommand } from "./internal/native-routes";
import { nativePairing } from "./internal/native-pairing";
import {
  localPATCredential as localCredential,
  patRouteProof as routeProof,
} from "./internal/native-pat";
import {
  patBrowserRoute as browserRoute,
  patDirectRoute as directRoute,
  patMethods as methods,
  patRoute as route,
} from "./internal/pat-routes";

export const patRoute = (path: string): boolean => route(path);

export const patDirectRoute = (path: string): boolean => directRoute(path);

export const patBrowserRoute = (path: string): boolean => browserRoute(path);

export const patMethods = (path: string): ReadonlyArray<string> => methods(path);

export const patRouteProof: typeof routeProof = (request) => routeProof(request);

export const localPATCredential: typeof localCredential = (input) => localCredential(input);

export const nativePATPairing: typeof nativePairing = (...args) => nativePairing(...args);

export const handlePATDirectoryCommand: typeof directoryPATCommand = (request) =>
  directoryPATCommand(request);

export const dispatchLocalPATGrant: typeof dispatchGrant = (input) => dispatchGrant(input);

export const isLocalPATGrant: typeof isNativeGrant = (id) => isNativeGrant(id);

export const stageLocalPATGrant: typeof stageGrant = (input) => stageGrant(input);

export const claimLocalPAT: typeof localClaim = (...args) => localClaim(...args);

export const isLocalPATManagement: typeof isPATManagement = (id) => isPATManagement(id);

export const dispatchLocalPATManagement: typeof dispatchManagement = (unit) =>
  dispatchManagement(unit);

export const repairLocalPATExpiry: typeof repairPATExpiry = (...args) => repairPATExpiry(...args);

export const recoverLocalPATExpiry: typeof sweepPATExpiry = (...args) => sweepPATExpiry(...args);

export const readLocalPATMetadata: typeof readMetadata = (input) => readMetadata(input);

export const readLocalPATActivity: typeof readActivity = (input) => readActivity(input);
