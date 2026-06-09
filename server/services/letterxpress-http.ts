import https from "node:https";

export interface LxHttpResponse {
  status: number;
  text: string;
}

/**
 * Low-level HTTP transport for the LetterXpress v2 API.
 *
 * LetterXpress v2 expects the JSON `auth` block in the request BODY for every
 * call — including `GET /v2/balance` (see the official curl / Python examples in
 * the LXP API v2 documentation). The global `fetch`/undici implementation throws
 * ("Request with GET/HEAD method cannot have body") when a body is attached to a
 * GET request, so we use `node:https` directly, which faithfully reproduces the
 * documented request shape for both the GET balance call and the POST setjob call.
 */
export function lxHttpRequest(opts: {
  url: string;
  method: string;
  body: string;
  timeoutMs: number;
}): Promise<LxHttpResponse> {
  const { url, method, body, timeoutMs } = opts;
  const parsed = new URL(url);
  return new Promise<LxHttpResponse>((resolve, reject) => {
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("LetterXpress-Zeitüberschreitung")));
    req.write(body);
    req.end();
  });
}
