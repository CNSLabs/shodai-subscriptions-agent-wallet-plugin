import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createSIWxPayload, encodeSIWxHeader, SIGN_IN_WITH_X } from "@x402/extensions/sign-in-with-x";
import type { Address, Hex } from "viem";
import { CommandError } from "@metamask/agent-wallet/plugin";
import { requestResource, resourceError } from "./http.js";

export async function accessResource(url: string, wallet: { address: Address; signMessage(message: string): Promise<Hex> }) {
  const challenge = await requestResource(url, { headers: { accept: "application/json" } }, "Access challenge");
  if (challenge.ok) return { status: challenge.status, content: await challenge.text() };
  const header = challenge.headers.get("payment-required");
  if (challenge.status !== 402 || !header) return resourceError(challenge, "Access challenge");
  const required = decodePaymentRequiredHeader(header);
  const extension = required.extensions?.[SIGN_IN_WITH_X] as Parameters<typeof createSIWxPayload>[0] & {
    info: Parameters<typeof createSIWxPayload>[0]; supportedChains: Array<{ chainId: string; type: "eip191" }>;
  } | undefined;
  if (!extension?.info || !extension.supportedChains?.length) throw new CommandError("SUBSCRIPTION_AUTH_UNSUPPORTED", "Access challenge does not advertise SIWx authentication", "Check the resource URL and its authentication offer.");
  const chain = extension.supportedChains.find(c => c.chainId === "eip155:84532");
  if (!chain) throw new CommandError("SUBSCRIPTION_AUTH_UNSUPPORTED", "Access challenge does not support Base Sepolia SIWx", "Use a Base Sepolia subscription resource.");
  const proof = await createSIWxPayload({ ...extension.info, ...chain }, {
    address: wallet.address, signMessage: ({ message }: { message: string }) => wallet.signMessage(message),
  }, url);
  const response = await requestResource(url, { headers: { "SIGN-IN-WITH-X": encodeSIWxHeader(proof) } }, "Authenticated access");
  if (!response.ok) return resourceError(response, "Authenticated access");
  return { status: response.status, content: await response.text() };
}
