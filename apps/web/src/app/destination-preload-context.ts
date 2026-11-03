import { createContext } from "react";

export const DestinationPreloadContext = createContext<
  Readonly<{ code: ReadonlyArray<Readonly<{ path: string; load: () => Promise<unknown> }>> }>
>({ code: [] });
