import { createContext } from "react";
import type { ActivePATList } from "@/transport/client";

export type PATListPreview = (list: ActivePATList) => ActivePATList;

export const PATListPreviewContext = createContext<PATListPreview>((list) => list);
