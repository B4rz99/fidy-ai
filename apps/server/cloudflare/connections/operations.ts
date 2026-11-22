import { prepareConnection, queryConnections } from "./internal/sqlite-connections";

export const queryLocalConnections: typeof queryConnections = (...args) =>
  queryConnections(...args);

export const prepareLocalConnection: typeof prepareConnection = (...args) =>
  prepareConnection(...args);
