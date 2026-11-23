import { createContext } from "react";
import { Option } from "effect";
import type { Detail, Workspace } from "./model";

export type WorkspacePreview = (view: Workspace, scope: "pending" | "history") => Workspace;

export type FixtureDetail = (item: Workspace["items"][number]) => Option.Option<Detail>;

export const WorkspacePreviewContext = createContext<WorkspacePreview>((view) => view);

export const FixtureDetailContext = createContext<FixtureDetail>(() => Option.none());
