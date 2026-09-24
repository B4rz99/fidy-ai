import { PATPairingDirectGroup, PATsGroup } from "@fidy/server/tokens-runtime";
import { HttpApi } from "effect/unstable/httpapi";
import { claimPATPairing } from "./pat-claim";
import { approvePATPairing, inspectPATPairing, startPATPairing } from "./pat-pairing";
import { createManualPAT, listPATs, revokeAllPATs, revokePAT } from "./pat-management";
import { matchesRoute } from "./route-match";

type PATHandler = (
  input: Readonly<{ request: Request; db: D1Database; path: string }>
) => Promise<Response>;
type OperationName =
  | keyof typeof PATPairingDirectGroup.endpoints
  | keyof typeof PATsGroup.endpoints;
const handlers = {
  start: startPATPairing,
  claim: claimPATPairing,
  inspectPATPairing,
  approvePATPairing,
  listPATs,
  createManualPAT,
  revokeAllPATs,
  revokePAT: ({ request, db, path }): Promise<Response> =>
    revokePAT({ request, db, shortId: path.split("/").at(-1) ?? "" }),
} satisfies Record<OperationName, PATHandler>;
const handlersByName: ReadonlyMap<string, PATHandler> = new Map(Object.entries(handlers));

const declared = HttpApi.make("patWorker").add(PATPairingDirectGroup).add(PATsGroup);
type Route = Readonly<{
  group: string;
  name: string;
  method: string;
  template: string;
}>;
const routes: Array<Route> = [];
HttpApi.reflect(declared, {
  onGroup: () => {},
  onEndpoint: ({ endpoint, group }) => {
    if (!handlersByName.has(endpoint.identifier)) throw new Error("Unimplemented PAT operation");
    routes.push({
      group: group.identifier,
      name: endpoint.identifier,
      method: endpoint.method,
      template: endpoint.path,
    });
  },
});
const forPath = (path: string): ReadonlyArray<Route> =>
  routes.filter((route) => matchesRoute(route.template, path));
/** PAT paths derive from the declared direct bootstrap and canonical operation groups. */
export const patRoute = (path: string): boolean => forPath(path).length > 0;
export const patDirectRoute = (path: string): boolean =>
  forPath(path).some((route) => route.group === PATPairingDirectGroup.identifier);
export const patBrowserRoute = (path: string): boolean =>
  forPath(path).some((route) => route.group === PATsGroup.identifier);
export const patMethods = (path: string): ReadonlyArray<string> =>
  Array.from(new Set(forPath(path).map((route) => route.method)));
/** Execute only a declared PAT operation, never a guessed path or method. */
export const handlePATRequest = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Promise<Response> => {
  const path = new URL(request.url).pathname;
  const route = forPath(path).find((candidate) => candidate.method === request.method);
  const handler = route === undefined ? undefined : handlersByName.get(route.name);
  return handler === undefined
    ? Promise.resolve(Response.json({ status: "method_not_allowed" }, { status: 405 }))
    : handler({ request, db, path });
};
