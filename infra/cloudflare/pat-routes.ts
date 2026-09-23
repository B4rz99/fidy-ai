import { claimPATPairing } from "./pat-claim";
import { approvePATPairing, inspectPATPairing, startPATPairing } from "./pat-pairing";
import { createManualPAT, listPATs, revokeAllPATs, revokePAT } from "./pat-management";

const directPaths = new Set(["/pat-pairings", "/pat-pairings/claim"]);
const browserPostPaths = new Set(["/pats/pairings/inspect", "/pats/pairings/approve"]);
const collection = "/pats";
const revocation = /^\/pats\/[a-z0-9]{8}$/u;
/** Routes retained from the canonical PAT HttpApi declaration; unknown paths fail closed. */
export const patRoute = (path: string): boolean =>
  directPaths.has(path) ||
  browserPostPaths.has(path) ||
  path === collection ||
  revocation.test(path);
export const patDirectRoute = (path: string): boolean => directPaths.has(path);
export const patBrowserRoute = (path: string): boolean =>
  browserPostPaths.has(path) || path === collection || revocation.test(path);
export const patMethods = (path: string): ReadonlyArray<string> => {
  if (path === collection) return ["GET", "POST", "DELETE"];
  if (revocation.test(path)) return ["DELETE"];
  return ["POST"];
};
const handlers = new Map<string, (request: Request, db: D1Database) => Promise<Response>>([
  ["POST /pat-pairings", startPATPairing],
  ["POST /pat-pairings/claim", claimPATPairing],
  ["POST /pats/pairings/inspect", inspectPATPairing],
  ["POST /pats/pairings/approve", approvePATPairing],
  ["GET /pats", listPATs],
  ["POST /pats", createManualPAT],
  ["DELETE /pats", revokeAllPATs],
]);
/** Only Core executes PAT handlers, after ingress has forwarded credential-only headers. */
export const handlePATRequest = (request: Request, db: D1Database): Promise<Response> => {
  const path = new URL(request.url).pathname;
  if (revocation.test(path) && request.method === "DELETE") {
    return revokePAT(request, db, path.slice(collection.length + 1));
  }
  const handler = handlers.get(`${request.method} ${path}`);
  return handler === undefined
    ? Promise.resolve(Response.json({ status: "method_not_allowed" }, { status: 405 }))
    : handler(request, db);
};
