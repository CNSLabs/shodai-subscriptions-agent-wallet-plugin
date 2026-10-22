import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createSIWxPayload, encodeSIWxHeader, type SIWxExtension } from "@x402/extensions/sign-in-with-x";
import { isAddress, type Address, type Hex } from "viem";
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

export type AuthenticationChallenge = { siwx: SIWxExtension; chainId: number };

function resourceChallenge(header: string, resourceUrl: string) {
  const required = decodePaymentRequiredHeader(header);
  if (required.x402Version !== 2 || required.resource?.url !== resourceUrl || !Array.isArray(required.accepts)) throw new Error("Invalid x402 resource binding");
  return required;
}

function validateAuthentication(siwx: SIWxExtension | undefined, resourceUrl: string, preferredChain?: number): AuthenticationChallenge {
  const now = Date.now();
  const info = siwx?.info;
  const issued = typeof info?.issuedAt === "string" ? Date.parse(info.issuedAt) : NaN;
  const expires = typeof info?.expirationTime === "string" ? Date.parse(info.expirationTime) : NaN;
  if (!info || info.version !== "1" || info.domain !== new URL(resourceUrl).host || info.uri !== resourceUrl ||
      typeof info.nonce !== "string" || !info.nonce || !Number.isFinite(issued) || !Number.isFinite(expires) ||
      issued > now + 30_000 || now - issued > 600_000 || expires <= now || expires <= issued || expires - issued > 600_000) {
    throw new Error("Invalid SIWx authentication challenge");
  }
  const chain = Array.isArray(siwx?.supportedChains) ? siwx.supportedChains.find(value => {
    const match = /^eip155:([1-9]\d*)$/.exec(value.chainId);
    const id = Number(match?.[1]);
    return value.type === "eip191" && Number.isSafeInteger(id) && (preferredChain === undefined || preferredChain === id);
  }) : undefined;
  if (!chain) throw new Error("SIWx has no compatible EVM authentication chain");
  return { siwx: siwx!, chainId: Number(chain.chainId.split(":")[1]) };
}

export function selectAuthentication(header: string, resourceUrl: string): AuthenticationChallenge {
  const required = resourceChallenge(header, resourceUrl);
  return validateAuthentication(required.extensions?.["sign-in-with-x"] as SIWxExtension | undefined, resourceUrl);
}

function sameOriginEndpoint(endpoint: string, resourceUrl: string): string {
  const url = new URL(endpoint, resourceUrl);
  if (url.origin !== new URL(resourceUrl).origin || url.username || url.password || url.hash) throw new Error("Invalid subscription endpoint origin");
  return url.href;
}

export function discoverStatus(header: string, resourceUrl: string): string | undefined {
  const required = resourceChallenge(header, resourceUrl);
  if (Object.hasOwn(required.extensions ?? {}, SUBSCRIPTION_SCHEME)) {
    const metadata = required.extensions![SUBSCRIPTION_SCHEME] as { version?: unknown; statusEndpoint?: unknown } | null;
    if (metadata?.version !== "1" || typeof metadata.statusEndpoint !== "string" || !metadata.statusEndpoint) throw new Error("Invalid subscription status discovery");
    return sameOriginEndpoint(metadata.statusEndpoint, resourceUrl);
  }
  const offers = required.accepts.filter(candidate => candidate.scheme === SUBSCRIPTION_SCHEME && candidate.extra?.version === "1");
  if (offers.length > 1) throw new Error("Ambiguous subscription status offers");
  const endpoint = offers[0]?.extra?.statusEndpoint;
  return typeof endpoint === "string" && endpoint ? sameOriginEndpoint(endpoint, resourceUrl) : undefined;
}

export function selectOffer(header: string, resourceUrl: string): SelectedOffer {
  const required = resourceChallenge(header, resourceUrl);
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
          !isAddress(candidate.payTo) || !isAddress(candidate.asset)) return [];
      const authentication = validateAuthentication(siwx, resourceUrl, chainId);
      const setupUrl = sameOriginEndpoint(extra.agentWalletSetup.endpoint, resourceUrl);
      const statusUrl = extra.statusEndpoint ? sameOriginEndpoint(extra.statusEndpoint, resourceUrl) : undefined;
      return [{ requirement: candidate as SelectedOffer["requirement"], resource: required.resource as unknown as Record<string, unknown>,
        chainId, native: candidate.asset.toLowerCase() === NATIVE_ETH_ASSET.toLowerCase(), setupUrl,
        statusUrl, siwx: authentication.siwx }];
    } catch { return []; }
  });
  if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous compatible subscription offers" : "No compatible subscription offer");
  return matches[0];
}

export async function signOffer(offer: SelectedOffer, resourceUrl: string, wallet: {
  address: Address; signMessage(message: string, chainId: number): Promise<Hex>;
}): Promise<string> {
  return signAuthentication(validateAuthentication(offer.siwx, resourceUrl, offer.chainId), resourceUrl, wallet);
}

export async function signAuthentication(challenge: AuthenticationChallenge, resourceUrl: string, wallet: {
  address: Address; signMessage(message: string, chainId: number): Promise<Hex>;
}): Promise<string> {
  validateAuthentication(challenge.siwx, resourceUrl, challenge.chainId);
  const chain = challenge.siwx.supportedChains.find(value => value.chainId === `eip155:${challenge.chainId}` && value.type === "eip191");
  if (!chain) throw new Error("SIWx does not support the offered chain");
  const payload = await createSIWxPayload({ ...challenge.siwx.info, ...chain }, {
    address: wallet.address,
    signMessage: ({ message }: { message: string }) => wallet.signMessage(message, challenge.chainId),
  }, resourceUrl);
  return encodeSIWxHeader(payload);
}
