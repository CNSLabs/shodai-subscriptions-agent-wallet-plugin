import type { Address, Hex } from "viem";
import { requestResource, resourceError } from "./http.js";
import { requestInit, type ResourceRequest } from "./request.js";
import { selectOffer, signOffer } from "./offer.js";

export async function accessResource(
  url: string,
  wallet: { address: Address; signMessage(message: string, chainId: number): Promise<Hex> },
  request: ResourceRequest = { method: "GET" },
  checkChain: (chainId: number) => Promise<void> = async () => {},
) {
  const challenge = await requestResource(url, requestInit(request), "Access challenge");
  if (challenge.ok) return { status: challenge.status, content: await challenge.text() };
  const header = challenge.headers.get("payment-required");
  if (challenge.status !== 402 || !header) return resourceError(challenge, "Access challenge");
  const offer = selectOffer(header, url);
  await checkChain(offer.chainId);
  const proof = await signOffer(offer, url, wallet);
  const response = await requestResource(url, requestInit(request, { "SIGN-IN-WITH-X": proof }), "Authenticated access");
  if (!response.ok) return resourceError(response, "Authenticated access");
  return { status: response.status, content: await response.text() };
}
