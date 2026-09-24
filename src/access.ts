import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { Address, Hex } from "viem";
import { CommandError } from "@metamask/agent-wallet/plugin";
import { requestResource, resourceError } from "./http.js";
import { requestInit, walletProof, type ResourceRequest } from "./request.js";
import { SUBSCRIPTION_SCHEME, type SubscriptionExtra } from "./protocol.js";

export async function accessResource(
  url: string,
  wallet: { address: Address; signMessage(message: string): Promise<Hex> },
  request: ResourceRequest = { method: "GET" },
) {
  const challenge = await requestResource(url, requestInit(request), "Access challenge");
  if (challenge.ok) return { status: challenge.status, content: await challenge.text() };
  const header = challenge.headers.get("payment-required");
  if (challenge.status !== 402 || !header) return resourceError(challenge, "Access challenge");
  const required = decodePaymentRequiredHeader(header);
  const extra = required.accepts.find(candidate => candidate.scheme === SUBSCRIPTION_SCHEME)?.extra as SubscriptionExtra | undefined;
  if (!extra?.challengeEndpoint) throw new CommandError("SUBSCRIPTION_AUTH_UNSUPPORTED", "Access challenge lacks wallet authentication", "Check the merchant offer.");
  const proof = await walletProof(extra.challengeEndpoint, url, request, wallet);
  const response = await requestResource(url, requestInit(request, { "x-shodai-wallet-proof": proof }), "Authenticated access");
  if (!response.ok) return resourceError(response, "Authenticated access");
  return { status: response.status, content: await response.text() };
}
