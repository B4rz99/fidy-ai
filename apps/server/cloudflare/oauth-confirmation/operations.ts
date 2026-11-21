import { localConfirmation } from "./internal/local";

export const confirmLocalOAuth: typeof localConfirmation = (...args) => localConfirmation(...args);
