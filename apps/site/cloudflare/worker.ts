type SiteEnvironment = {
  ASSETS: { fetch(request: Request): Promise<Response> };
};
const notModified = 304;
const notFound = 404;

const specificity = (range: string, media: string): number => {
  if (range === media) return 2;
  if (range === "text/*") return 1;
  if (range === "*/*") return 0;
  return -1;
};

const quality = (accept: string, media: string): number => {
  const ranges = accept
    .toLowerCase()
    .split(",")
    .map((range) => {
      const [type = "", ...parameters] = range.trim().split(";");
      const parameter = parameters.find((value) => value.trim().startsWith("q="));
      const raw = parameter?.trim().slice(2) ?? "1";
      return {
        specificity: specificity(type.trim(), media),
        quality: /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(raw) ? Number(raw) : 0,
      };
    });
  const preferred = ranges
    .filter((range) => range.specificity >= 0)
    .sort((left, right) => right.specificity - left.specificity || right.quality - left.quality);
  return preferred[0]?.quality ?? 0;
};

const prefersMarkdown = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? "";
  const markdownQuality = quality(accept, "text/markdown");
  return (
    accept.toLowerCase().includes("text/markdown") &&
    markdownQuality > 0 &&
    markdownQuality >= quality(accept, "text/html")
  );
};

const canNegotiate = (request: Request, response: Response): boolean =>
  ["GET", "HEAD"].includes(request.method) &&
  (response.status === notModified ||
    Boolean(response.headers.get("content-type")?.includes("text/html")));

const renderMarkdown = async (
  request: Request,
  response: Response,
  context: { environment: SiteEnvironment; headers: Headers }
): Promise<Response> => {
  const { environment, headers } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/u, "").replace(/\.html$/u, "") || "/index";
  url.pathname = response.status === notFound ? "/404.md" : `${path}.md`;
  url.search = "";
  const markdown = await environment.ASSETS.fetch(new Request(url, { method: "GET" }));
  if (!markdown.ok) return new Response(response.body, { status: response.status, headers });
  headers.set("content-type", "text/markdown; charset=utf-8");
  if (response.status === notFound || ["/terminos", "/404"].includes(path)) {
    headers.set("x-robots-tag", "noindex");
  }
  for (const name of ["content-length", "content-encoding", "etag", "last-modified"]) {
    headers.delete(name);
  }
  return new Response(request.method === "HEAD" ? null : markdown.body, {
    status: response.status,
    headers,
  });
};

export default {
  async fetch(request: Request, environment: SiteEnvironment): Promise<Response> {
    const wantsMarkdown = prefersMarkdown(request);
    const assetRequest = new Request(request);
    if (wantsMarkdown) {
      for (const name of ["if-none-match", "if-modified-since", "range"]) {
        assetRequest.headers.delete(name);
      }
    }
    const response = await environment.ASSETS.fetch(assetRequest);
    if (!canNegotiate(request, response)) return response;
    const headers = new Headers(response.headers);
    const vary = headers.get("vary");
    headers.set("vary", vary ? `${vary}, Accept` : "Accept");
    if (wantsMarkdown) return renderMarkdown(request, response, { environment, headers });
    return new Response(response.body, { status: response.status, headers });
  },
};
