import { randomBytes } from "node:crypto";
import { Args } from "@oclif/core";
import { CommandError, PluginCommand, type CommandIO } from "@metamask/agent-wallet/plugin";
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { encodeFunctionData, encodePacked, erc20Abi, getAddress, isAddressEqual, keccak256, parseAbi, toBytes, zeroAddress, zeroHash } from "viem";
import { AgentWalletSubscriptionClient } from "../../subscription-client.js";
import { activationTypedData, type SubscriptionExtra } from "../../protocol.js";
import { adapterAbi, agreementAbi } from "../../abis.js";
import { CHAIN_ID, resourceUrl, subscriptionWallet } from "../../wallet.js";
import { requestResource, resourceError } from "../../http.js";
import { ensureAgreementTrust } from "../../trust.js";

export default class Subscribe extends PluginCommand<object> {
  protected readonly pluginCommandId = "shodai:subscribe";
  static usage = "mm shodai subscribe <resource-url>";
  static description = "Subscribe to an x402 shodai-subscription resource with the selected Agent Wallet. Creates a bounded recurring-payment permission, establishes Agreement trust, and returns the protected content.";
  static args = { "resource-url": Args.string({ required: true }) };
  static flags = { ...PluginCommand.baseFlags };
  async execute(io: CommandIO) {
    const url = resourceUrl(this.ctx.args?.["resource-url"]);
    const wallet = await subscriptionWallet(this.ctx, io, this.pluginCommandId);
    const client = new AgentWalletSubscriptionClient(wallet);
    const started = await client.begin(url);
    const requirement = started.requirements as unknown as PaymentRequirements;
    const extra = requirement.extra as SubscriptionExtra;
    const terms = { asset: requirement.asset, amountAtomic: requirement.amount, ...extra.token,
      periodSeconds: extra.periodDuration, merchant: requirement.payTo, network: requirement.network };
    io.emit(`Subscription terms: ${JSON.stringify(terms)}`);
    const record = started.record;
    const publicClient = this.ctx.publicClient(CHAIN_ID);
    const state = await publicClient.readContract({ address: record.agreement, abi: agreementAbi, functionName: "currentState" });
    if (state !== keccak256(toBytes("AUTO_RENEW_ON"))) throw new CommandError("SUBSCRIPTION_CANCELED", "This Agreement is not open for renewal", "Start a new subscription from the resource offer.");
    const paidThrough = await publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "lastPaidThrough" });
    if (paidThrough > 0n) throw new CommandError("SUBSCRIPTION_ALREADY_ACTIVATED", "This subscription has already collected its initial payment", "Use shodai status or shodai access instead of subscribing again.");
    const bound = await publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "agreement" });
    if (bound !== zeroAddress && !isAddressEqual(bound, record.agreement)) throw new CommandError("SUBSCRIPTION_BINDING_MISMATCH", "Adapter is bound to another Agreement", "Check the resource's subscription setup.");
    const installed = await publicClient.readContract({ address: record.adapter, abi: adapterAbi, functionName: "permissionContext" });
    const permissionContext = installed === "0x" ? await client.createPermission(started) : null;
    const binding = bound === zeroAddress
      ? await wallet.send(record.adapter, encodeFunctionData({ abi: adapterAbi, functionName: "bindAgreement", args: [record.agreement] }), "Bind subscription Agreement to payment adapter",
        { function: "bindAgreement(address)", arguments: { agreement: record.agreement } })
      : { alreadyBound: true, target: record.adapter, agreement: record.agreement };
    let installation: object = { alreadyInstalled: true, target: record.adapter };
    if (permissionContext) {
      const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [record.merchant, BigInt(requirement.amount)] });
      const execution = encodePacked(["address", "uint256", "bytes"], [getAddress(requirement.asset), 0n, transfer]);
      await publicClient.call({ account: record.adapter, to: record.manager, data: encodeFunctionData({
        abi: parseAbi(["function redeemDelegations(bytes[],bytes32[],bytes[]) payable"]),
        functionName: "redeemDelegations", args: [[permissionContext], [zeroHash], [execution]],
      }) });
      installation = await wallet.send(record.adapter, encodeFunctionData({ abi: adapterAbi, functionName: "installPermissionContext", args: [permissionContext] }), "Install bounded subscription permission",
        { function: "installPermissionContext(bytes)", arguments: { permissionContext: `${(permissionContext.length - 2) / 2} bytes; Agent Wallet -> adapter`, agentWallet: wallet.address, adapter: record.adapter, terms } });
    }
    const trust = await ensureAgreementTrust(wallet.address, record.agreement, io);
    const activation = { recordId: record.id, planId: record.planId, subscriber: wallet.address, payer: record.payer,
      resource: url, nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`, deadline: Math.floor(Date.now() / 1000) + 600 };
    const signature = await wallet.signTypedData({ chainId: CHAIN_ID, ...activationTypedData(activation, CHAIN_ID, record.merchant), intent: "Activate subscription and authorize initial collection" });
    const payment = { x402Version: 2, payload: { ...activation, signature } };
    const response = await requestResource(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
      ...payment, resource: started.resource as unknown as ResourceInfo, accepted: requirement,
    }) } }, "Subscription activation");
    if (!response.ok) return resourceError(response, "Subscription activation");
    const paymentResponse = response.headers.get("payment-response");
    const collection = paymentResponse ? decodePaymentResponseHeader(paymentResponse) : null;
    return { resource: url, agreement: record.agreement, adapter: record.adapter, payer: record.payer,
      terms, binding, installation, trust, collection, status: response.status, content: await response.text() };
  }
}
