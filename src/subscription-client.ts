import { encodeDelegations } from "@metamask/delegation-core";
import { createDelegation, getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { signDelegation } from "@metamask/smart-accounts-kit/actions";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { isAddressEqual, pad, type Address, type Hex, type TypedData } from "viem";
import { type SubscriptionExtra, type SubscriptionRecord } from "./protocol.js";
import { requestInit, type ResourceRequest } from "./request.js";
import { selectAuthentication, selectOffer, signAuthentication, type SelectedOffer } from "./offer.js";
import { requestResource } from "./http.js";

type JsonRecord = Record<string, unknown>;

export interface SubscriptionWallet {
  getAddress(): Promise<Address>;
  signMessage(message: string, chainId: number): Promise<Hex>;
  signTypedData(input: { chainId: number; domain: JsonRecord; types: TypedData; primaryType: string; message: JsonRecord; intent: string }): Promise<Hex>;
}

export type AgentWalletSetup = {
  record: SubscriptionRecord;
  permission: { startTime: number; expiry: number };
  requirements: JsonRecord;
  resource: JsonRecord;
  offer: SelectedOffer;
  proof: string;
};

export class AgentWalletSubscriptionClient {
  constructor(
    private readonly agentWallet: SubscriptionWallet,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly checkChain: (chainId: number) => Promise<void> = async () => {},
  ) {}

  async begin(resourceUrl: string, request: ResourceRequest = { method: "GET" }): Promise<AgentWalletSetup | { alreadyCovered: Response }> {
    const authenticated = await this.authenticate(resourceUrl, request);
    if ("alreadyCovered" in authenticated) return authenticated;
    const agentWallet = await this.agentWallet.getAddress();
    const { proof, response } = authenticated;
    const currentHeader = response.headers.get("payment-required");
    if (!currentHeader) throw new Error("Authenticated 402 is missing PAYMENT-REQUIRED");
    const offer = selectOffer(currentHeader, resourceUrl);
    await this.checkChain(offer.chainId);
    const requirement = offer.requirement;
    const extra = requirement.extra;
    const setupUrl = offer.setupUrl;
    const setupBody = { planId: extra.planId, agentWallet };
    const setup = await postJson(this.fetchImpl, setupUrl, setupBody, { "SIGN-IN-WITH-X": proof }) as {
      record?: SubscriptionRecord;
      permission?: { startTime?: number; expiry?: number };
    };
    if (!setup.record || !setup.permission || !Number.isSafeInteger(setup.permission.startTime) || !Number.isSafeInteger(setup.permission.expiry)) {
      throw new Error("Setup service returned incomplete subscription details");
    }
    if (!isAddressEqual(setup.record.subscriber, agentWallet)) throw new Error("Provisioned subscription belongs to a different Agent Wallet");
    return {
      record: setup.record,
      permission: setup.permission as { startTime: number; expiry: number },
      requirements: requirement as unknown as JsonRecord,
      resource: offer.resource,
      offer,
      proof,
    };
  }

  async authenticate(resourceUrl: string, request: ResourceRequest = { method: "GET" }): Promise<{ alreadyCovered: Response } | { response: Response; proof: string }> {
    const response = await this.fetchImpl(resourceUrl, requestInit(request));
    if (response.ok) return { alreadyCovered: response };
    if (response.status !== 402) throw new Error(`Expected initial 402, received ${response.status}`);
    const header = response.headers.get("payment-required");
    if (!header) throw new Error("402 response is missing PAYMENT-REQUIRED");
    const challenge = selectAuthentication(header, resourceUrl);
    await this.checkChain(challenge.chainId);
    const address = await this.agentWallet.getAddress();
    const proof = await signAuthentication(challenge, resourceUrl, { address, signMessage: (message, chainId) => this.agentWallet.signMessage(message, chainId) });
    const authenticated = await this.fetchImpl(resourceUrl, requestInit(request, { "SIGN-IN-WITH-X": proof }));
    if (authenticated.ok) return { alreadyCovered: authenticated };
    if (authenticated.status !== 402) throw new Error(`Authenticated request returned ${authenticated.status}: ${await authenticated.text()}`);
    return { response: authenticated, proof };
  }

  async requestAuthorizedResource(resourceUrl: string, request: ResourceRequest, proof: string, paymentHeader: string): Promise<Response> {
    const send = (currentProof: string) => requestResource(resourceUrl, requestInit(request, { "SIGN-IN-WITH-X": currentProof, "PAYMENT-SIGNATURE": paymentHeader }), "Subscription activation", this.fetchImpl);
    const response = await send(proof);
    if (response.status !== 401 || !(await response.clone().text()).includes("Invalid or expired SIGN-IN-WITH-X proof")) return response;
    const refreshed = await this.authenticate(resourceUrl, request);
    if ("alreadyCovered" in refreshed) return refreshed.alreadyCovered;
    return send(refreshed.proof);
  }

  async createPermission(setup: AgentWalletSetup, expiry = setup.permission.expiry): Promise<Hex> {
    const requirement = setup.requirements as { asset: Address; amount: string; payTo: Address; extra: SubscriptionExtra };
    const { record, permission } = setup;
    const address = await this.agentWallet.getAddress();
    if (!isAddressEqual(address, record.subscriber)) throw new Error("Setup belongs to a different Agent Wallet");
    if (!isAddressEqual(requirement.payTo, record.merchant)) throw new Error("Provisioned subscription does not match the advertised merchant");
    const environment = getSmartAccountsEnvironment(setup.offer.chainId);
    if (!isAddressEqual(environment.DelegationManager, record.manager)) throw new Error("Provisioned subscription uses an unsupported Delegation Manager");
    if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) throw new Error("Delegation expiry must be in the future");
    const caveats = createCaveatBuilder(environment)
      .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: expiry })
      .addCaveat("redeemer", { redeemers: [record.adapter] })
      .addCaveat(setup.offer.native ? "allowedTargets" : "allowedCalldata",
        setup.offer.native ? { targets: [record.merchant] } : { startIndex: 4, value: pad(record.merchant) })
      .build();
    const delegation = createDelegation({
      environment,
      from: record.payer,
      to: record.adapter,
      scope: setup.offer.native ? {
        type: "nativeTokenPeriodTransfer", periodAmount: BigInt(requirement.amount),
        periodDuration: requirement.extra.periodDuration, startDate: permission.startTime,
      } : {
        type: "erc20PeriodTransfer", tokenAddress: requirement.asset,
        periodAmount: BigInt(requirement.amount), periodDuration: requirement.extra.periodDuration,
        startDate: permission.startTime,
      },
      caveats,
    });
    const signingClient = {
      account: { address, type: "json-rpc" },
      chain: { id: setup.offer.chainId },
      signTypedData: async (parameters: { domain: JsonRecord; types: TypedData; primaryType: string; message: JsonRecord }) =>
        this.agentWallet.signTypedData({ chainId: setup.offer.chainId, ...parameters, intent: `Authorize bounded subscription payments to ${record.merchant}` }),
    };
    const signature = await signDelegation(signingClient as any, {
      account: address,
      delegation,
      delegationManager: environment.DelegationManager,
      chainId: setup.offer.chainId,
    });
    return encodeDelegations([{ ...delegation, salt: BigInt(delegation.salt), signature }]);
  }
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const response = await fetchImpl(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}
