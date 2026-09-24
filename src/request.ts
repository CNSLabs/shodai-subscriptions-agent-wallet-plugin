import { CommandError } from "@metamask/agent-wallet/plugin";
import type { Address, Hex } from "viem";
import { requestResource } from "./http.js";
import { resourceUrl } from "./wallet.js";

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
    headers: { accept: "application/json", ...(request.body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(request.body === undefined ? {} : { body: request.body }),
  };
}

export async function walletProof(
  endpoint: string,
  resource: string,
  request: ResourceRequest,
  wallet: { address: Address; signMessage(message: string): Promise<Hex> },
): Promise<string> {
  const challengeUrl = resourceUrl(endpoint);
  if (new URL(challengeUrl).origin !== new URL(resource).origin) {
    throw new CommandError("SUBSCRIPTION_AUTH_UNSUPPORTED", "Wallet challenge must be on the resource origin", "Check the advertised subscription offer.");
  }
  const challengeBody = {
    address: wallet.address,
    method: request.method,
    resource,
    ...(request.body === undefined ? {} : { body: JSON.parse(request.body) }),
  };
  const response = await requestResource(challengeUrl, requestInit({ method: "POST", body: JSON.stringify(challengeBody) }), "Wallet challenge");
  if (!response.ok) throw new Error(`Wallet challenge failed with HTTP ${response.status}: ${await response.text()}`);
  const challenge = await response.json() as { challengeId?: string; message?: string };
  if (!challenge.challengeId || !challenge.message || !challenge.message.includes(`Resource: ${resource}`)) {
    throw new Error("Wallet challenge does not match the requested resource");
  }
  const signature = await wallet.signMessage(challenge.message);
  return Buffer.from(JSON.stringify({ challengeId: challenge.challengeId, signature }), "utf8").toString("base64url");
}
