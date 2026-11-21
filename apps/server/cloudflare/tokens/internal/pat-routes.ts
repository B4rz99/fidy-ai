import { PATPairingDirectGroup, PATsGroup } from "../../../src/shell/tokens/contract";
import { HttpApi } from "effect/http-api";
import { matchesRouteTemplate } from "../../../src/shell/public-http/operations";

const declared = HttpApi.make("patWorker").add(PATPairingDirectGroup).add(PATsGroup);

type Route = Readonly<{
  group: string;
  method: string;
  template: string;
}>;

const routes: Array<Route> = [];

HttpApi.reflect(declared, {
  onGroup: () => {},
  onEndpoint: ({ endpoint, group }) => {
    routes.push({
      group: group.identifier,
      method: endpoint.method,
      template: endpoint.path,
    });
  },
});

const forPath = (path: string): ReadonlyArray<Route> =>
  routes.filter((route) => matchesRouteTemplate({ template: route.template, path }));

export const patRoute = (path: string): boolean => forPath(path).length > 0;

export const patDirectRoute = (path: string): boolean =>
  forPath(path).some((route) => route.group === PATPairingDirectGroup.identifier);

export const patBrowserRoute = (path: string): boolean =>
  forPath(path).some((route) => route.group === PATsGroup.identifier);

export const patMethods = (path: string): ReadonlyArray<string> =>
  Array.from(new Set(forPath(path).map((route) => route.method)));
