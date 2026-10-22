export type ResourceRequest = { method: string; body?: string };

export function resourceRequest(flags: { method?: string; body?: string }): ResourceRequest {
  const method = (flags.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) throw new Error(`Unsupported HTTP method: ${method}`);
  if (flags.body !== undefined && ["GET", "DELETE"].includes(method)) throw new Error(`${method} cannot include a request body`);
  if (flags.body !== undefined) {
    try { JSON.parse(flags.body); } catch { throw new Error("Request body must be JSON"); }
  }
  return { method, ...(flags.body !== undefined ? { body: flags.body } : {}) };
}

export function requestInit(request: ResourceRequest, headers: Record<string, string> = {}): RequestInit {
  return {
    method: request.method,
    redirect: "error",
    headers: { accept: "application/json", ...(request.body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(request.body === undefined ? {} : { body: request.body }),
  };
}
