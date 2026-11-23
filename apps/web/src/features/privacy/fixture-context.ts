import { createContext } from "react";
import type { ProcessingConsentStatus } from "@/transport/client";

export type ConsentStatusPreview = (status: ProcessingConsentStatus) => ProcessingConsentStatus;

export const ConsentStatusPreviewContext = createContext<ConsentStatusPreview>((status) => status);
