import { randomBytes } from "node:crypto";
import { Args, Flags } from "@oclif/core";
import { CommandError, PluginCommand, type CommandIO } from "@metamask/agent-wallet/plugin";
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { decodeDelegations, createAllowedCalldataTerms, createAllowedTargetsTerms, createERC20TokenPeriodTransferTerms, createNativeTokenPeriodTransferTerms, createRedeemerTerms } from "@metamask/delegation-core";
import { getSmartAccountsEnvironment, Implementation, toMetaMaskSmartAccount } from "@metamask/smart-accounts-kit";
import { encodeFunctionData, encodePacked, getAddress, isAddressEqual, keccak256, pad, parseAbi, toBytes, zeroAddress, zeroHash, type PublicClient } from "viem";
import { AgentWalletSubscriptionClient, type AgentWalletSetup } from "../../subscription-client.js";
import { activationTypedData, type SubscriptionExtra } from "../../protocol.js";
import { adapterAbi, agreementAbi, erc20Abi, tokenAdapterAbi } from "../../abis.js";
import { resourceUrl, subscriptionWallet } from "../../wallet.js";
import { collectionOutcome, resourceError } from "../../http.js";
import { resourceRequest } from "../../request.js";
import { ensureAgreementTrust } from "../../trust.js";

export default class Subscribe extends PluginCommand<object> {
  protected readonly pluginCommandId = "shodai:subscribe";
  static usage = "mm shodai subscribe <resource-url> [--method POST] [--body JSON]";
  static summary = "mm shodai subscribe <resource-url> - subscribe and perform the requested operation";
  static description = "Subscribe to an x402 shodai-subscription resource with the selected Agent Wallet. Creates a bounded recurring-payment permission, establishes Agreement trust, and performs the original request.";
  static args = { "resource-url": Args.string({ required: true }) };
  static flags = { ...PluginCommand.baseFlags, method: Flags.string({ default: "GET" }), body: Flags.string(),
    "expires-at": Flags.string({ description: "Delegation expiry as an ISO date/time; setup defaults to 24 hours" }) };

  async execute(io: CommandIO) {
    const url = resourceUrl(this.ctx.args?.["resource-url"]);
    const request = resourceRequest(this.ctx.flags ?? {});
    const wallet = await subscriptionWallet(this.ctx, io, this.pluginCommandId);
    const client = new AgentWalletSubscriptionClient(wallet, fetch, async chainId => {
      try {
        const chain = this.ctx.publicClient(chainId);
        getSmartAccountsEnvironment(chainId);
        if (await chain.getChainId() !== chainId) throw new Error("RPC chain mismatch");
      } catch {
        throw new CommandError("SUBSCRIPTION_CHAIN_UNSUPPORTED", `Wallet, RPC, or delegation environment does not support chain ${chainId}`, "Choose a supported offer chain.");
      }
    });
    const started = await client.begin(url, request);
    if ("alreadyCovered" in started) return { resource: url, status: started.alreadyCovered.status, content: await started.alreadyCovered.text() };
    const requirement = started.requirements as unknown as PaymentRequirements;
    const extra = requirement.extra as SubscriptionExtra;
    const record = started.record;
    const { chainId, native } = started.offer;
    let publicClient: ReturnType<typeof this.ctx.publicClient>, environment: ReturnType<typeof getSmartAccountsEnvironment>;
    try {
      publicClient = this.ctx.publicClient(chainId);
      environment = getSmartAccountsEnvironment(chainId);
      if (await publicClient.getChainId() !== chainId) throw new Error("RPC chain mismatch");
    } catch {
      throw new CommandError("SUBSCRIPTION_CHAIN_UNSUPPORTED", `Wallet, RPC, or delegation environment does not support chain ${chainId}`, "Choose a supported offer chain.");
    }
    const enforcer = native ? environment.caveatEnforcers.NativeTokenPeriodTransferEnforcer : environment.caveatEnforcers.ERC20PeriodTransferEnforcer;
    if (!isAddressEqual(record.manager, environment.DelegationManager) ||
        !isAddressEqual(record.enforcer, enforcer) || !isAddressEqual(record.merchant, getAddress(requirement.payTo)) ||
        record.planId !== extra.planId) {
      throw new CommandError("SUBSCRIPTION_TERMS_MISMATCH", "Subscription chain or terms do not match the offer", "Inspect the merchant offer before approving.");
    }
    const derived = await toMetaMaskSmartAccount({ client: smartAccountPublicClient(publicClient, chainId),
      implementation: Implementation.Hybrid, environment, deployParams: [wallet.address, [], [], []], deploySalt: "0x00" });
    if (!isAddressEqual(derived.address, record.payer) || !(await derived.isDeployed())) {
      throw new CommandError("SUBSCRIPTION_PAYER_MISMATCH", "The deployed payer does not derive from the selected wallet", "Do not fund this address.");
    }
    const [adapterCode, agreementCode, state, bound, paidThrough, installed, amount, duration, startTime, payer, subscriber, merchant, token] = await Promise.all([
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
      native ? Promise.resolve(requirement.asset) : publicClient.readContract({ address: record.adapter, abi: tokenAdapterAbi, functionName: "token" }),
    ]);
    if (!adapterCode || !agreementCode || !isAddressEqual(payer, record.payer) || !isAddressEqual(subscriber, wallet.address) ||
        !isAddressEqual(merchant, getAddress(requirement.payTo)) || amount !== BigInt(requirement.amount) ||
        duration !== BigInt(extra.periodDuration) || startTime !== BigInt(started.permission.startTime) ||
        (bound !== zeroAddress && !isAddressEqual(bound, record.agreement)) || !isAddressEqual(getAddress(token), getAddress(requirement.asset))) {
      throw new CommandError("SUBSCRIPTION_SETUP_MISMATCH", "Adapter or Agreement does not match the advertised setup", "Do not fund or activate this payer.");
    }
    if (state !== keccak256(toBytes("AUTO_RENEW_ON"))) {
      throw new CommandError("SUBSCRIPTION_CANCELED", "This Agreement is not open for renewal", "Start a new subscription from the resource offer.");
    }
    if (paidThrough > BigInt(Math.floor(Date.now() / 1000))) {
      throw new CommandError("SUBSCRIPTION_COVERAGE_MISMATCH", "The Agreement is still paid through, but the resource returned an unpaid offer", "Check merchant entitlement state before authorizing another payment.");
    }
    if (installed !== "0x") verifyPermission(installed, started, requirement);
    const balance = native ? await publicClient.getBalance({ address: record.payer }) :
      await publicClient.readContract({ address: getAddress(requirement.asset), abi: erc20Abi, functionName: "balanceOf", args: [record.payer] });
    const terms = { asset: native ? `native ${extra.token?.symbol ?? "asset"}` : requirement.asset, amountAtomic: requirement.amount, periodSeconds: extra.periodDuration,
      recipient: requirement.payTo, network: requirement.network };
    io.emit(`Subscription terms: ${JSON.stringify(terms)}`);
    io.emit(`Verified payer: ${record.payer}; balance: ${balance} atomic units; paid through: ${paidThrough}`);
    if (balance < BigInt(requirement.amount)) {
      return { fundingRequired: true, payer: record.payer, payerBalanceAtomic: balance.toString(), minimumAtomic: requirement.amount, terms };
    }
    const binding = bound === zeroAddress
      ? await wallet.send(chainId, record.adapter, encodeFunctionData({ abi: adapterAbi, functionName: "bindAgreement", args: [record.agreement] }), "Bind subscription Agreement to payment adapter",
        { function: "bindAgreement(address)", arguments: { agreement: record.agreement } })
      : { alreadyBound: true, target: record.adapter, agreement: record.agreement };
    let installation: object = { alreadyInstalled: true, target: record.adapter };
    if (installed === "0x") {
      const expiresAt = this.ctx.flags?.["expires-at"]
        ? Math.floor(new Date(String(this.ctx.flags["expires-at"])).getTime() / 1000) : started.permission.expiry;
      const permissionContext = await client.createPermission(started, expiresAt);
      verifyPermission(permissionContext, started, requirement);
      const execution = native ? encodePacked(["address", "uint256", "bytes"], [record.merchant, BigInt(requirement.amount), "0x"]) :
        encodePacked(["address", "uint256", "bytes"], [getAddress(requirement.asset), 0n,
          encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [record.merchant, BigInt(requirement.amount)] })]);
      await publicClient.call({ account: record.adapter, to: record.manager, data: encodeFunctionData({
        abi: parseAbi(["function redeemDelegations(bytes[],bytes32[],bytes[]) payable"]),
        functionName: "redeemDelegations", args: [[permissionContext], [zeroHash], [execution]] }) });
      installation = await wallet.send(chainId, record.adapter, encodeFunctionData({ abi: adapterAbi, functionName: "installPermissionContext", args: [permissionContext] }), "Install bounded subscription permission",
        { function: "installPermissionContext(bytes)", arguments: { permissionContext: `${(permissionContext.length - 2) / 2} bytes`, subscriber: wallet.address, adapter: record.adapter, terms } });
    }
    const trust = await ensureAgreementTrust(wallet.address, record.agreement, chainId, io);
    const activation = { recordId: record.id, planId: record.planId, subscriber: wallet.address, payer: record.payer,
      resource: url, nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`, deadline: Math.floor(Date.now() / 1000) + 600 };
    const signature = await wallet.signTypedData({ chainId, ...activationTypedData(activation, chainId, record.merchant), intent: "Activate subscription and authorize initial collection" });
    const payment = { x402Version: 2, payload: { ...activation, signature } };
    const response = await client.requestAuthorizedResource(url, request, started.proof,
      encodePaymentSignatureHeader({ ...payment, resource: started.resource as unknown as ResourceInfo, accepted: requirement }));
    const outcome = await collectionOutcome(response);
    if (outcome) return { resource: url, status: response.status, ...outcome };
    if (!response.ok) return resourceError(response, "Subscription activation");
    const paymentResponse = response.headers.get("payment-response");
    const collection = paymentResponse ? decodePaymentResponseHeader(paymentResponse) : null;
    return { resource: url, agreement: record.agreement, adapter: record.adapter, payer: record.payer,
      terms, binding, installation, trust, collection, status: response.status, content: await response.text() };
  }
}

export function smartAccountPublicClient(client: PublicClient, chainId: number): Parameters<typeof toMetaMaskSmartAccount>[0]["client"] {
  if (client.chain && client.chain.id !== chainId) throw new Error("RPC client chain mismatch");
  return { ...client, chain: client.chain ?? { id: chainId } } as unknown as Parameters<typeof toMetaMaskSmartAccount>[0]["client"];
}

function verifyPermission(context: `0x${string}`, setup: AgentWalletSetup, requirement: PaymentRequirements): void {
  const delegations = decodeDelegations(context);
  const environment = getSmartAccountsEnvironment(setup.offer.chainId);
  const { record, permission } = setup;
  const native = setup.offer.native;
  const expected = [
    [native ? environment.caveatEnforcers.NativeTokenPeriodTransferEnforcer : environment.caveatEnforcers.ERC20PeriodTransferEnforcer,
      native ? createNativeTokenPeriodTransferTerms({ periodAmount: BigInt(requirement.amount), periodDuration: Number(requirement.extra.periodDuration), startDate: permission.startTime }) :
        createERC20TokenPeriodTransferTerms({ tokenAddress: getAddress(requirement.asset), periodAmount: BigInt(requirement.amount), periodDuration: Number(requirement.extra.periodDuration), startDate: permission.startTime })],
    [environment.caveatEnforcers.RedeemerEnforcer, createRedeemerTerms({ redeemers: [record.adapter] })],
    [native ? environment.caveatEnforcers.AllowedTargetsEnforcer : environment.caveatEnforcers.AllowedCalldataEnforcer,
      native ? createAllowedTargetsTerms({ targets: [record.merchant] }) : createAllowedCalldataTerms({ startIndex: 4, value: pad(record.merchant) })],
  ];
  const timestamp = delegations[0]?.caveats.find(caveat =>
    caveat.enforcer.toLowerCase() === environment.caveatEnforcers.TimestampEnforcer.toLowerCase());
  if (delegations.length !== 1 || !isAddressEqual(delegations[0].delegate, record.adapter) ||
      !isAddressEqual(delegations[0].delegator, record.payer) ||
      !isAddressEqual(record.manager, environment.DelegationManager) ||
      !expected.every(([enforcer, terms]) => delegations[0].caveats.some(caveat =>
        caveat.enforcer.toLowerCase() === enforcer.toLowerCase() && caveat.terms.toLowerCase() === terms.toLowerCase())) ||
      !timestamp || timestamp.terms.length !== 66) {
    throw new CommandError("SUBSCRIPTION_PERMISSION_MISMATCH", "Recurring permission does not match the subscription terms", "Do not approve or activate it.");
  }
  const before = BigInt(`0x${timestamp.terms.slice(-32)}`);
  if (before <= BigInt(Math.floor(Date.now() / 1000)) || before > BigInt(permission.expiry)) {
    throw new CommandError("SUBSCRIPTION_PERMISSION_EXPIRED", "Installed recurring permission has expired", "Start a fresh subscription setup; do not activate this Agreement.");
  }
}
