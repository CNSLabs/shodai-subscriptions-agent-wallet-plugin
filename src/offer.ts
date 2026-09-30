import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createSIWxPayload, encodeSIWxHeader, type SIWxExtension } from "@x402/extensions/sign-in-with-x";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { NATIVE_ETH_ASSET, SUBSCRIPTION_SCHEME, type SubscriptionExtra } from "./protocol.js";

export type SelectedOffer = {
  requirement: {
    scheme: string; network: string; asset: Address; amount: string; payTo: Address;
    extra: SubscriptionExtra; maxTimeoutSeconds: number;
  };
  resource: Record<string, unknown>;
  chainId: number;
  native: boolean;
  setupUrl: string;
  statusUrl?: string;
  siwx: SIWxExtension;
};

export function selectOffer(header: string, resourceUrl: string): SelectedOffer {
  const required = decodePaymentRequiredHeader(header);
  if (required.x402Version !== 2 || required.resource?.url !== resourceUrl) throw new Error("Invalid x402 resource binding");
  const siwx = required.extensions?.["sign-in-with-x"] as SIWxExtension | undefined;
  const matches = required.accepts.flatMap(candidate => {
    try {
      if (candidate.scheme !== SUBSCRIPTION_SCHEME) return [];
      const chainMatch = /^eip155:([1-9]\d*)$/.exec(candidate.network);
      const chainId = Number(chainMatch?.[1]);
      const extra = candidate.extra as SubscriptionExtra;
      if (!Number.isSafeInteger(chainId) || !/^[1-9]\d*$/.test(candidate.amount) ||
          !Number.isSafeInteger(extra?.periodDuration) || extra.periodDuration <= 0 ||
          extra.version !== "1" || !extra.planId || !extra.agentWalletSetup?.endpoint ||
          !isAddress(candidate.payTo) || !isAddress(candidate.asset) ||
          !siwx?.info || siwx.info.version !== "1" ||
          !siwx.supportedChains?.some(chain => chain.chainId === candidate.network && chain.type === "eip191")) return [];
      const origin = new URL(resourceUrl).origin;
      const now = Date.now();
      const issued = Date.parse(siwx.info.issuedAt);
      const expires = Date.parse(siwx.info.expirationTime ?? "");
      if (siwx.info.domain !== new URL(origin).host || siwx.info.uri !== resourceUrl ||
          !siwx.info.nonce || !Number.isFinite(issued) || !Number.isFinite(expires) ||
          issued > now + 30_000 || now - issued > 600_000 || expires <= now || expires - issued > 600_000) return [];
      const setupUrl = new URL(extra.agentWalletSetup.endpoint, resourceUrl);
      const statusUrl = extra.statusEndpoint ? new URL(extra.statusEndpoint, resourceUrl) : undefined;
      if (setupUrl.origin !== origin || (statusUrl && statusUrl.origin !== origin)) return [];
      return [{ requirement: candidate as SelectedOffer["requirement"], resource: required.resource as unknown as Record<string, unknown>,
        chainId, native: candidate.asset.toLowerCase() === NATIVE_ETH_ASSET.toLowerCase(), setupUrl: setupUrl.href,
        statusUrl: statusUrl?.href, siwx }];
    } catch { return []; }
  });
  if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous compatible subscription offers" : "No compatible subscription offer");
  return matches[0];
}

export async function signOffer(offer: SelectedOffer, resourceUrl: string, wallet: {
  address: Address; signMessage(message: string, chainId: number): Promise<Hex>;
}): Promise<string> {
  const chain = offer.siwx.supportedChains.find(value => value.chainId === offer.requirement.network && value.type === "eip191");
  if (!chain) throw new Error("SIWx does not support the offered chain");
  const payload = await createSIWxPayload({ ...offer.siwx.info, ...chain }, {
    address: wallet.address,
    signMessage: ({ message }: { message: string }) => wallet.signMessage(message, offer.chainId),
  }, resourceUrl);
  return encodeSIWxHeader(payload);
}
