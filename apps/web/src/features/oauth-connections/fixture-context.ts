import { createContext } from "react";
import type { OAuthConnectionList } from "@/transport/client";

export type ConnectionListPreview = (list: OAuthConnectionList) => OAuthConnectionList;

export const ConnectionListPreviewContext = createContext<ConnectionListPreview>((list) => list);
