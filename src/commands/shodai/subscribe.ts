import { randomBytes } from "node:crypto";
import { Args, Flags } from "@oclif/core";
import { CommandError, PluginCommand, type CommandIO } from "@metamask/agent-wallet/plugin";
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { decodeDelegations, createAllowedTargetsTerms, createNativeTokenPeriodTransferTerms, createRedeemerTerms } from "@metamask/delegation-core";
import { getSmartAccountsEnvironment, Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { encodeFunctionData, encodePacked, getAddress, isAddressEqual, keccak256, parseAbi, toBytes, zeroAddress, zeroHash } from "viem";
import { baseSepolia } from "viem/chains";
import { AgentWalletSubscriptionClient, type AgentWalletSetup } from "../../subscription-client.js";
import { activationTypedData, NATIVE_ETH_ASSET, type SubscriptionExtra } from "../../protocol.js";
import { adapterAbi, agreementAbi } from "../../abis.js";
import { CHAIN_ID, resourceUrl, subscriptionWallet } from "../../wallet.js";
import { requestResource, resourceError } from "../../http.js";
import { requestInit, resourceRequest, walletProof } from "../../request.js";
import { ensureAgreementTrust } from "../../trust.js";

export default class Subscribe extends PluginCommand<object> {
  protected readonly pluginCommandId = "shodai:subscribe";
  static usage = "mm shodai subscribe <resource-url> [--method POST] [--body JSON]";
  static summary = "mm shodai subscribe <resource-url> - subscribe and perform the requested operation";
  static description = "Subscribe to an x402 shodai-subscription resource with the selected Agent Wallet. Creates a bounded recurring-payment permission, establishes Agreement trust, and performs the original request.";
  static args = { "resource-url": Args.string({ required: true }) };
  static flags = { ...PluginCommand.baseFlags, method: Flags.string({ default: "GET" }), body: Flags.string(),
    "expires-at": Flags.string({ description: "Delegation expiry as an ISO date/time; defaults to one year" }) };

  async execute(io: CommandIO) {
    const url = resourceUrl(this.ctx.args?.["resource-url"]);
    const request = resourceRequest(this.ctx.flags ?? {});
    const wallet = await subscriptionWallet(this.ctx, io, this.pluginCommandId);
    const client = new AgentWalletSubscriptionClient(wallet);
    const started = await client.begin(url, request);
    if ("alreadyCovered" in started) return { resource: url, status: started.alreadyCovered.status, content: await started.alreadyCovered.text() };
    const requirement = started.requirements as unknown as PaymentRequirements;
    const extra = requirement.extra as SubscriptionExtra;
    const record = started.record;
    const publicClient = this.ctx.publicClient(CHAIN_ID);
    const environment = getSmartAccountsEnvironment(CHAIN_ID);
    if (await publicClient.getChainId() !== CHAIN_ID || !isAddressEqual(record.manager, environment.DelegationManager) ||
        !isAddressEqual(record.enforcer, environment.caveatEnforcers.NativeTokenPeriodTransferEnforcer) ||
        !isAddressEqual(record.merchant, getAddress(requirement.payTo)) || requirement.asset.toLowerCase() !== NATIVE_ETH_ASSET.toLowerCase()) {
      throw new CommandError("SUBSCRIPTION_TERMS_MISMATCH", "Subscription chain or terms do not match the advertised native ETH offer", "Inspect the merchant offer before approving.");
    }
    const derived = await toMetaMaskSmartAccount({ client: { ...publicClient, chain: baseSepolia } as unknown as Parameters<typeof toMetaMaskSmartAccount>[0]["client"],
      implementation: Implementation.Hybrid, environment, deployParams: [wallet.address, [], [], []], deploySalt: "0x00" });
    if (!isAddressEqual(derived.address, record.payer) || !(await derived.isDeployed())) {
      throw new CommandError("SUBSCRIPTION_PAYER_MISMATCH", "The deployed payer does not derive from the selected wallet", "Do not fund this address.");
    }
    const [adapterCode, agreementCode, state, bound, paidThrough, installed, amount, duration, startTime, payer, subscriber, merchant] = await Promise.all([
      publicClient.getCode({ address: record.adapter }), publicClient.getCode({ address: record.agreement }),
      publicClient.readContract({ address: record.agreement, abi: agreementAbi, functionName: "currentState" }),
      publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "agreement" }),
      publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "lastPaidThrough" }),
      publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "permissionContext" }),
      publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "periodAmount" }),
      publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "periodDuration" }),
      publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "startTime" }),
      publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "payer" }),
      publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "subscriber" }),
      publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "merchant" }),
    ]);
    if (!adapterCode || !agreementCode || !isAddressEqual(payer, record.payer) || !isAddressEqual(subscriber, wallet.address) ||
        !isAddressEqual(merchant, getAddress(requirement.payTo)) || amount !== BigInt(requirement.amount) ||
        duration !== BigInt(extra.periodDuration) || startTime !== BigInt(started.permission.startTime) ||
        (bound !== zeroAddress && !isAddressEqual(bound, record.agreement))) {
      throw new CommandError("SUBSCRIPTION_SETUP_MISMATCH", "Adapter or Agreement does not match the advertised setup", "Do not fund or activate this payer.");
    }
    const balance = await publicClient.getBalance({ address: record.payer });
    const terms = { asset: "native ETH", amountWei: requirement.amount, periodSeconds: extra.periodDuration,
      recipient: requirement.payTo, network: requirement.network };
    io.emit(`Subscription terms: ${JSON.stringify(terms)}`);
    io.emit(`Verified payer: ${record.payer}; balance: ${balance} wei`);
    if (paidThrough > BigInt(Math.floor(Date.now() / 1000))) {
      const proof = await walletProof(extra.challengeEndpoint!, url, request, wallet);
      const response = await requestResource(url, requestInit(request, { "x-shodai-wallet-proof": proof }), "Covered subscription access");
      if (!response.ok) return resourceError(response, "Covered subscription access");
      return { resource: url, status: response.status, content: await response.text(), alreadyCovered: true };
    }
    if (balance < BigInt(requirement.amount)) {
      return { fundingRequired: true, payer: record.payer, payerBalanceWei: balance.toString(), minimumWei: requirement.amount, terms };
    }
    if (state !== keccak256(toBytes("AUTO_RENEW_ON"))) {
      throw new CommandError("SUBSCRIPTION_CANCELED", "This Agreement is not open for renewal", "Start a new subscription from the resource offer.");
    }
    if (installed !== "0x") verifyPermission(installed, started, requirement);
    const binding = bound === zeroAddress
      ? await wallet.send(record.adapter, encodeFunctionData({ abi: adapterAbi, functionName: "bindAgreement", args: [record.agreement] }), "Bind subscription Agreement to payment adapter",
        { function: "bindAgreement(address)", arguments: { agreement: record.agreement } })
      : { alreadyBound: true, target: record.adapter, agreement: record.agreement };
    let installation: object = { alreadyInstalled: true, target: record.adapter };
    if (installed === "0x") {
      const expiresAt = this.ctx.flags?.["expires-at"]
        ? Math.floor(new Date(String(this.ctx.flags["expires-at"])).getTime() / 1000) : started.permission.expiry;
      const permissionContext = await client.createPermission(started, expiresAt);
      verifyPermission(permissionContext, started, requirement);
      const execution = encodePacked(["address", "uint256", "bytes"], [record.merchant, BigInt(requirement.amount), "0x"]);
      await publicClient.call({ account: record.adapter, to: record.manager, data: encodeFunctionData({
        abi: parseAbi(["function redeemDelegations(bytes[],bytes32[],bytes[]) payable"]),
        functionName: "redeemDelegations", args: [[permissionContext], [zeroHash], [execution]] }) });
      installation = await wallet.send(record.adapter, encodeFunctionData({ abi: adapterAbi, functionName: "installPermissionContext", args: [permissionContext] }), "Install bounded subscription permission",
        { function: "installPermissionContext(bytes)", arguments: { permissionContext: `${(permissionContext.length - 2) / 2} bytes`, subscriber: wallet.address, adapter: record.adapter, terms } });
    }
    const trust = await ensureAgreementTrust(wallet.address, record.agreement, io);
    const activation = { recordId: record.id, planId: record.planId, subscriber: wallet.address, payer: record.payer,
      resource: url, nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`, deadline: Math.floor(Date.now() / 1000) + 600 };
    const signature = await wallet.signTypedData({ chainId: CHAIN_ID, ...activationTypedData(activation, CHAIN_ID, record.merchant), intent: "Activate subscription and authorize initial collection" });
    const proof = await walletProof(extra.challengeEndpoint!, url, request, wallet);
    const payment = { x402Version: 2, payload: { ...activation, signature } };
    const response = await requestResource(url, requestInit(request, {
      "x-shodai-wallet-proof": proof,
      "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({ ...payment, resource: started.resource as unknown as ResourceInfo, accepted: requirement }),
    }), "Subscription activation");
    if (!response.ok) return resourceError(response, "Subscription activation");
    const paymentResponse = response.headers.get("payment-response");
    const collection = paymentResponse ? decodePaymentResponseHeader(paymentResponse) : null;
    return { resource: url, agreement: record.agreement, adapter: record.adapter, payer: record.payer,
      terms, binding, installation, trust, collection, status: response.status, content: await response.text() };
  }
}

function verifyPermission(context: `0x${string}`, setup: AgentWalletSetup, requirement: PaymentRequirements): void {
  const delegations = decodeDelegations(context);
  const environment = getSmartAccountsEnvironment(CHAIN_ID);
  const { record, permission } = setup;
  const expected = [
    [environment.caveatEnforcers.NativeTokenPeriodTransferEnforcer,
      createNativeTokenPeriodTransferTerms({ periodAmount: BigInt(requirement.amount), periodDuration: Number(requirement.extra.periodDuration), startDate: permission.startTime })],
    [environment.caveatEnforcers.RedeemerEnforcer, createRedeemerTerms({ redeemers: [record.adapter] })],
    [environment.caveatEnforcers.AllowedTargetsEnforcer, createAllowedTargetsTerms({ targets: [record.merchant] })],
  ];
  const timestamp = delegations[0]?.caveats.find(caveat =>
    caveat.enforcer.toLowerCase() === environment.caveatEnforcers.TimestampEnforcer.toLowerCase());
  if (delegations.length !== 1 || !isAddressEqual(delegations[0].delegate, record.adapter) ||
      !isAddressEqual(delegations[0].delegator, record.payer) ||
      !expected.every(([enforcer, terms]) => delegations[0].caveats.some(caveat =>
        caveat.enforcer.toLowerCase() === enforcer.toLowerCase() && caveat.terms.toLowerCase() === terms.toLowerCase())) ||
      !timestamp || timestamp.terms.length !== 66) {
    throw new CommandError("SUBSCRIPTION_PERMISSION_MISMATCH", "Recurring permission does not match the subscription terms", "Do not approve or activate it.");
  }
  const before = BigInt(`0x${timestamp.terms.slice(-32)}`);
  if (before !== 0n && before <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new CommandError("SUBSCRIPTION_PERMISSION_EXPIRED", "Installed recurring permission has expired", "Start a fresh subscription setup; do not activate this Agreement.");
  }
}
