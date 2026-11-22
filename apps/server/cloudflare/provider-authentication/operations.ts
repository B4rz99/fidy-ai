import {
  rejectionReason as callbackFailure,
  callbackRedirect as nativeCallbackRedirect,
  cookieVerifier as nativeCookieVerifier,
  validCode as nativeValidCode,
} from "./internal/callback";
import {
  microsoftProviderPaths,
  providerPaths,
} from "../../src/shell/provider-authentication/contract";
import {
  prepareAttempt as nativePrepareAttempt,
  startedResponse as nativeStartedResponse,
} from "./internal/start";
import { providerConfiguration as nativeProviderConfiguration } from "./internal/configuration";
import { validateGoogleToken as nativeValidateGoogleToken } from "./internal/google-token";
import { validateMicrosoftToken as nativeValidateMicrosoftToken } from "./internal/microsoft-token";

export const ownsProviderAuthenticationPath = (path: string): boolean =>
  [...Object.values(providerPaths), ...Object.values(microsoftProviderPaths)].some(
    (owned) => owned === path
  );

export const providerConfiguration: typeof nativeProviderConfiguration = (...args) =>
  nativeProviderConfiguration(...args);

export const callbackRedirect: typeof nativeCallbackRedirect = (...args) =>
  nativeCallbackRedirect(...args);

export const cookieVerifier: typeof nativeCookieVerifier = (...args) =>
  nativeCookieVerifier(...args);

export const validCode: typeof nativeValidCode = (...args) => nativeValidCode(...args);

export const prepareAttempt: typeof nativePrepareAttempt = (...args) =>
  nativePrepareAttempt(...args);

export const startedResponse: typeof nativeStartedResponse = (...args) =>
  nativeStartedResponse(...args);

export const validateGoogleToken: typeof nativeValidateGoogleToken = (...args) =>
  nativeValidateGoogleToken(...args);

export const validateMicrosoftToken: typeof nativeValidateMicrosoftToken = (...args) =>
  nativeValidateMicrosoftToken(...args);

export const providerRejectionReason: typeof callbackFailure = (failure) =>
  callbackFailure(failure);
