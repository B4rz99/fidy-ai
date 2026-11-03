import { createContext } from "react";

export const DestinationCodeContext = createContext<
  ReadonlyArray<Readonly<{ path: string; load: () => Promise<unknown> }>>
>([]);
