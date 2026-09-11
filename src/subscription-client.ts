import { decodePaymentRequiredHeader } from "@x402/core/http";
import { encodeDelegations } from "@metamask/delegation-core";
import { createDelegation, getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { signDelegation } from "@metamask/smart-accounts-kit/actions";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { getAddress, isAddressEqual, padHex, type Address, type Hex, type TypedData } from "viem";
import { SUBSCRIPTION_SCHEME, type SubscriptionExtra, type SubscriptionRecord } from "./protocol.js";

type JsonRecord = Record<string, unknown>;

export interface SubscriptionWallet {
  getAddress(): Promise<Address>;
  signTypedData(input: { chainId: number; domain: JsonRecord; types: TypedData; primaryType: string; message: JsonRecord; intent: string }): Promise<Hex>;
}

export type AgentWalletSetup = {
  record: SubscriptionRecord;
  permission: { startTime: number; expiry: number };
  requirements: JsonRecord;
  resource: JsonRecord;
};

export class AgentWalletSubscriptionClient {
  constructor(
    private readonly agentWallet: SubscriptionWallet,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async begin(resourceUrl: string): Promise<AgentWalletSetup> {
    const agentWallet = await this.agentWallet.getAddress();
    const response = await this.fetchImpl(resourceUrl, { headers: { accept: "application/json" } });
    if (response.status !== 402) throw new Error(`Expected initial 402, received ${response.status}`);
    const header = response.headers.get("payment-required");
    if (!header) throw new Error("402 response is missing PAYMENT-REQUIRED");
    const required = decodePaymentRequiredHeader(header);
    const requirement = required.accepts.find((candidate) => candidate.scheme === SUBSCRIPTION_SCHEME);
    if (!requirement) throw new Error("402 does not advertise shodai-subscription");
    const extra = requirement.extra as SubscriptionExtra;
    if (requirement.network !== "eip155:84532" || !extra.planId || extra.periodDuration <= 0 || !extra.agentWalletSetup) {
      throw new Error("Subscription requirements are incomplete or unsupported");
    }
    const setup = await postJson(this.fetchImpl, extra.agentWalletSetup.endpoint, { planId: extra.planId, agentWallet }) as {
      record?: SubscriptionRecord;
      permission?: { startTime?: number; expiry?: number };
    };
    if (!setup.record || !setup.permission || !Number.isInteger(setup.permission.startTime) || !Number.isInteger(setup.permission.expiry)) {
      throw new Error("Setup service returned incomplete subscription details");
    }
    if (!isAddressEqual(setup.record.subscriber, agentWallet)) throw new Error("Provisioned subscription belongs to a different Agent Wallet");
    return {
      record: setup.record,
      permission: setup.permission as { startTime: number; expiry: number },
      requirements: requirement as unknown as JsonRecord,
      resource: required.resource as unknown as JsonRecord,
    };
  }

  async createPermission(setup: AgentWalletSetup): Promise<Hex> {
    const requirement = setup.requirements as { asset: Address; amount: string; payTo: Address; extra: SubscriptionExtra };
    const { record, permission } = setup;
    const address = await this.agentWallet.getAddress();
    if (!isAddressEqual(address, record.subscriber)) throw new Error("Setup belongs to a different Agent Wallet");
    if (!isAddressEqual(requirement.payTo, record.merchant)) throw new Error("Provisioned subscription does not match the advertised merchant");
    const environment = getSmartAccountsEnvironment(84532);
    if (!isAddressEqual(environment.DelegationManager, record.manager)) throw new Error("Provisioned subscription uses an unsupported Delegation Manager");
    const caveats = createCaveatBuilder(environment)
      .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: permission.expiry })
      .addCaveat("redeemer", { redeemers: [record.adapter] })
      .addCaveat("allowedCalldata", { startIndex: 4, value: padHex(record.merchant, { size: 32 }) })
      .build();
    const delegation = createDelegation({
      environment,
      from: record.payer,
      to: record.adapter,
      scope: {
        type: "erc20PeriodTransfer",
        tokenAddress: getAddress(requirement.asset),
        periodAmount: BigInt(requirement.amount),
        periodDuration: requirement.extra.periodDuration,
        startDate: permission.startTime,
      },
      caveats,
    });
    const signingClient = {
      account: { address, type: "json-rpc" },
      chain: { id: 84532 },
      signTypedData: async (parameters: { domain: JsonRecord; types: TypedData; primaryType: string; message: JsonRecord }) =>
        this.agentWallet.signTypedData({ chainId: 84532, ...parameters, intent: `Authorize bounded subscription payments to ${record.merchant}` }),
    };
    const signature = await signDelegation(signingClient as any, {
      account: address,
      delegation,
      delegationManager: environment.DelegationManager,
      chainId: 84532,
    });
    return encodeDelegations([{ ...delegation, salt: BigInt(delegation.salt), signature }]);
  }
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}
