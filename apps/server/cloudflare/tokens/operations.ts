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
import { prepareBoundPATList as prepareList } from "./internal/bound-pats";
import type { CanonicalBrowserRead } from "../canonical-admission/contract";
import { Effect } from "effect";
import { type CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import {
  type AuthorizedPAT,
  type PATActivityRead,
  type PATAuthorizationDecision,
  type PATMetadataQuery,
  type PATRequest,
  PATUnavailable,
} from "./contract";
import {
  authorizeCanonicalPAT as authorize,
  resolveCanonicalPATCredential as resolveCredential,
} from "./internal/pat-authorization";
import {
  patBrowserRoute as browserRoute,
  patDirectRoute as directRoute,
  handlePATRequest as handle,
  patMethods as methods,
  patRoute as route,
} from "./internal/pat-routes";
import { getActivity, getHeldActivity } from "./internal/pat-activity";
import { listPATsForCaller as list } from "./internal/pat-management";
import { commitPATUnit as commit } from "./internal/pat-unit";

export const authorizeCanonicalPAT = (
  input: PATRequest & Readonly<{ operation: CatalogOperation }>
): Effect.Effect<AuthorizedPAT | Exclude<PATAuthorizationDecision, "accepted">, PATUnavailable> =>
  authorize(input).pipe(Effect.mapError(() => new PATUnavailable()));

export const resolveCanonicalPATCredential = (
  input: PATRequest & Readonly<{ operation: CatalogOperation }>
): Effect.Effect<AuthorizedPAT | "unauthenticated" | "user_action_required", PATUnavailable> =>
  resolveCredential(input).pipe(Effect.mapError(() => new PATUnavailable()));

export const handlePATRequest = (input: PATRequest): Effect.Effect<Response, PATUnavailable> =>
  handle(input).pipe(Effect.mapError(() => new PATUnavailable()));

export const listPATs = (input: PATMetadataQuery): Effect.Effect<Response> => list(input);

export const commitPATUnit = (
  input: Readonly<{ db: D1Database; statements: ReadonlyArray<D1PreparedStatement> }>
): Promise<ReadonlyArray<D1Result>> => commit(input);

export const patRoute = (path: string): boolean => route(path);

export const patDirectRoute = (path: string): boolean => directRoute(path);

export const patBrowserRoute = (path: string): boolean => browserRoute(path);

export const patMethods = (path: string): ReadonlyArray<string> => methods(path);

export const getPATActivity = (
  input: PATMetadataQuery & Readonly<{ shortId: string }>
): Effect.Effect<Response> => getActivity(input);

export const getHeldPATActivity = (input: PATActivityRead): Effect.Effect<Response> =>
  getHeldActivity(input);

export const prepareBoundPATList: CanonicalBrowserRead = (input) => prepareList(input);

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
