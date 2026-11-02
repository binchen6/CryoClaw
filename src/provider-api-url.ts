/** SDK base URLs are stored unchanged. Complete request endpoints are invalid. */
export function providerBaseUrl(baseURL: string): URL {
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || /\/(?:responses|messages|chat\/completions)\/*$/i.test(url.pathname)) {
    throw new Error("Base URL must be a service base, not a request endpoint");
  }
  return url;
}

export function resolveV1Endpoint(baseURL: string, endpoint: "messages" | "responses"): string {
  const url = providerBaseUrl(baseURL);
  const base = endpoint === "responses" ? url.pathname.replace(/\/$/, "") : url.pathname.replace(/\/+$/, "");
  // OpenAI's SDK appends /responses to its exact configured base path.
  url.pathname = endpoint === "responses" ? `${base}/responses` : `${base.endsWith("/v1") ? base : `${base}/v1`}/messages`;
  return url.toString();
}
