import type { Layer } from "effect";
import { HttpClientRequest } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import type { TokenBearer } from "~/core/tokens/contract";
import { TokenAuthorization } from "./contract";

export const TokenAuthorizationClientAnonymousLive: Layer.Layer<
  HttpApiMiddleware.ForClient<TokenAuthorization>
> = HttpApiMiddleware.layerClient(TokenAuthorization, ({ next, request }) => next(request));

export const makeTokenAuthorizationClientLive = (
  bearer: TokenBearer
): Layer.Layer<HttpApiMiddleware.ForClient<TokenAuthorization>> =>
  HttpApiMiddleware.layerClient(TokenAuthorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, bearer))
  );
