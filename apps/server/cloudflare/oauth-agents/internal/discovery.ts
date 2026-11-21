import { oauthIssuer, oauthPaths, oauthResource } from "../../../src/shell/oauth-agents/contract";
import { oauthResponse as response } from "./response";

const unavailableStatus = 503;

const successStatus = 200;

export const discoveryResponse = (path: string): Response => {
  if (path === oauthPaths.resource) {
    return response({
      status: successStatus,
      body: {
        resource: oauthResource,
        authorization_servers: [oauthIssuer],
        scopes_supported: ["read"],
        bearer_methods_supported: ["header"],
      },
    });
  }

  if (path === oauthPaths.issuer) {
    return response({
      status: successStatus,
      body: {
        issuer: oauthIssuer,
        authorization_endpoint: `${oauthIssuer}${oauthPaths.authorize}`,
        token_endpoint: `${oauthIssuer}${oauthPaths.token}`,
        registration_endpoint: `${oauthIssuer}${oauthPaths.register}`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["read", "write", "dashboard"],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: false,
      },
    });
  }

  if (path === oauthPaths.mcp) {
    return new Response(null, {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${oauthIssuer}${oauthPaths.resource}", scope="read"`,
      },
    });
  }

  return response({ body: { error: "temporarily_unavailable" }, status: unavailableStatus });
};
