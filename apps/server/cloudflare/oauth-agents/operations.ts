import { nativeManagement } from "./internal/native-management";
import { canonicalLocalRequest } from "./internal/native-operation";
import { accessSubject, denied as denyAccess, nativeCaller } from "./internal/native-access";
import { exchangeLocalToken } from "./internal/native-token";
import { oauthCredentialCommand } from "./internal/native-registration";
import { nativeOAuthBrowser } from "./internal/native-browser";
import { nativePublicOAuth } from "./internal/native-directory";

export const publicOAuthRequest: typeof nativePublicOAuth = (input) => nativePublicOAuth(input);

export const handleOAuthRouteCommand: typeof oauthCredentialCommand = (request) =>
  oauthCredentialCommand(request);

export const handleOAuthReview: typeof nativeOAuthBrowser = (input) => nativeOAuthBrowser(input);

export const handleOAuthToken: typeof exchangeLocalToken = (...args) => exchangeLocalToken(...args);

export const localOAuthAccessSubject: typeof accessSubject = (...args) => accessSubject(...args);

export const resolveLocalOAuthCaller: typeof nativeCaller = (input) => nativeCaller(input);

export const denyMcpAccess = (): Response => denyAccess();

export const localOAuthCanonicalRequest: typeof canonicalLocalRequest = (...args) =>
  canonicalLocalRequest(...args);

export const handleLocalOAuthManagement: typeof nativeManagement = (input) =>
  nativeManagement(input);
