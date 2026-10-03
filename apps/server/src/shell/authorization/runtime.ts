import type { Layer } from "effect";
import { HttpClientRequest } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import type { TokenBearer } from "~/core/tokens/contract";
import { TokenAuthorization } from "./contract";

/** Lets an unauthenticated derived client call the API and receive its declared 401 response. */
export const TokenAuthorizationClientAnonymousLive: Layer.Layer<
  HttpApiMiddleware.ForClient<TokenAuthorization>
> = HttpApiMiddleware.layerClient(TokenAuthorization, ({ next, request }) => next(request));

/** Adds one opaque TokenBearer to every request made through the derived client. */
export const makeTokenAuthorizationClientLive = (
  bearer: TokenBearer
): Layer.Layer<HttpApiMiddleware.ForClient<TokenAuthorization>> =>
  HttpApiMiddleware.layerClient(TokenAuthorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, bearer))
  );
