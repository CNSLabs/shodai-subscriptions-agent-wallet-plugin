import type { Address, Hex } from "viem";

export const SUBSCRIPTION_SCHEME = "shodai-subscription";
export const SUBSCRIPTION_VERSION = "1";

export type SubscriptionExtra = {
  version: string;
  planId: string;
  periodDuration: number;
  statusEndpoint?: string;
  token: { symbol: string; decimals: number; formattedAmount: string };
  agentWalletSetup?: { endpoint: string };
  cancellationPolicy: string;
  assetTransferMethod?: string;
  paymentFlow?: string;
};

export type SubscriptionRecord = {
  id: string;
  planId: string;
  subscriber: Address;
  payer: Address;
  merchant: Address;
  agreement: Address;
  adapter: Address;
  manager: Address;
  enforcer: Address;
  status: "pending" | "active" | "canceled";
};

export type Activation = {
  recordId: string;
  planId: string;
  subscriber: Address;
  payer: Address;
  resource: string;
  nonce: Hex;
  deadline: number;
  signature: Hex;
};

export type CollectionAttempt = {
  recordId: string;
  kind: "initial" | "automatic";
  attemptedAt: string;
  outcome: "pending" | "success" | "failed";
  transaction?: Hex;
  receipt?: { status: "success"; hash: Hex; blockNumber: string };
  paidThrough?: string;
  error?: string;
};

export type SubscriptionStatus = {
  subscription: Pick<SubscriptionRecord, "id" | "subscriber" | "payer" | "merchant" | "agreement" | "adapter"> | null;
  renewalEnabled: boolean | null;
  accessPaid: boolean | null;
  paidThrough: string | null;
  latestCollection: CollectionAttempt | null;
  renewalError: string | null;
};

export function activationTypedData(
  activation: Omit<Activation, "signature">,
  chainId: number,
  verifyingContract: Address,
) {
  return {
    domain: { name: "Shodai Subscription", version: SUBSCRIPTION_VERSION, chainId, verifyingContract },
    types: {
      Activation: [
        { name: "recordId", type: "string" },
        { name: "planId", type: "string" },
        { name: "subscriber", type: "address" },
        { name: "payer", type: "address" },
        { name: "resource", type: "string" },
        { name: "nonce", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Activation" as const,
    message: activation,
  };
}
