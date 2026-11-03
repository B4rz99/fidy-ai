import { createContext } from "react";

export const DestinationPreloadContext = createContext<
  Readonly<{
    idle: () => boolean;
    code: ReadonlyArray<Readonly<{ path: string; load: () => Promise<unknown> }>>;
    display: ReadonlyArray<Readonly<{ path: string; prepare: () => Promise<void> }>>;
  }>
>({ idle: () => false, code: [], display: [] });
