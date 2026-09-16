import assert from "node:assert/strict";
import { test } from "node:test";
import yaml from "js-yaml";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { decodeAllowedCalldataTerms, decodeDelegations, decodeERC20TokenPeriodTransferTerms, decodeRedeemerTerms, decodeTimestampTerms } from "@metamask/delegation-core";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { isAddressEqual, keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { resourceUrl, subscriptionWallet } from "../src/wallet.js";
import { accessResource } from "../src/access.js";
import { AgentWalletSubscriptionClient } from "../src/subscription-client.js";
import type { SubscriptionRecord } from "../src/protocol.js";
import { ensureAgreementTrust, policyCli } from "../src/trust.js";
import Access from "../src/commands/shodai/access.js";
import Cancel from "../src/commands/shodai/cancel.js";
import Subscribe from "../src/commands/shodai/subscribe.js";
import Status from "../src/commands/shodai/status.js";

const address = "0x1111111111111111111111111111111111111111";
const agreement = "0x2222222222222222222222222222222222222222";
const record: SubscriptionRecord = { id: "test", planId: "test", subscriber: address, payer: agreement,
  merchant: address, agreement, adapter: address, manager: address, enforcer: address, status: "pending" };
const io = { notify: () => {}, emit: () => {} } as any;

test("subscribe help describes the direct Agent Wallet journey", () => {
  assert.match(Subscribe.description, /selected Agent Wallet/);
  assert.match(Subscribe.description, /bounded recurring-payment permission/);
});

test("topic summaries show every required positional argument", () => {
  assert.match(Subscribe.summary, /subscribe <resource-url>/);
  assert.match(Access.summary, /access <resource-url>/);
  assert.match(Status.summary, /status <resource-url>/);
  assert.match(Cancel.summary, /cancel <agreement-address>/);
});

test("setup trust adds only the Agreement and preserves the existing policy", async t => {
  const baseline = { schema_version: 1, wallet_address: address,
    addresses: { allowlist: [{ address, chain_id: 1 }], blocklist: [] },
    evm: { allowed_chains: [84532], outflow_limits_usd: { rolling_24h: 0 } } };
  let policy = structuredClone(baseline), writes = 0;
  t.mock.method(policyCli, "run", async (command, _io, input) => {
    if (command === "get") return { address, policy: yaml.dump(policy) };
    writes++;
    policy = yaml.load(input!) as typeof policy;
    return { status: "confirmed" };
  });
  assert.equal((await ensureAgreementTrust(address, agreement, io)).alreadyTrusted, false);
  assert.deepEqual(policy, { ...baseline, addresses: { ...baseline.addresses,
    allowlist: [...baseline.addresses.allowlist, { address: agreement, chain_id: 84532 }] } });
  assert.equal((await ensureAgreementTrust(address, agreement, io)).alreadyTrusted, true);
  assert.equal(writes, 1);
});

test("message uses the stock executor API; mismatched SIWx fails before signing", async t => {
  const origin = "https://subscription.example";
  const ctx = { walletStateManager: { read: () => ({ selectedWallet: { namespace: "evm", mode: "server", ref: { address } }, remoteWallets: [{ address }] }) },
    walletExecutor: async () => async (request: any) => {
      assert.deepEqual(request, { kind: "message", chainId: 84532, message: "message",
        intent: { action: "custom", summary: "Authenticate subscription resource access" } });
      return { kind: "signature", signature: "0xab" };
    } };
  const wallet = await subscriptionWallet(ctx as any, io, "test");
  assert.equal(await wallet.signMessage("message"), "0xab");
  let signed = false;
  const offer = { x402Version: 2, resource: { url: `${origin}/subscriber-resource` }, accepts: [], extensions: {
    "sign-in-with-x": { info: { domain: "other.example", uri: "https://other.example/subscriber-resource", version: "1", nonce: "12345678", issuedAt: new Date().toISOString() },
      supportedChains: [{ chainId: "eip155:84532", type: "eip191" }] } } };
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(offer as any) } }));
  await assert.rejects(() => accessResource(`${origin}/subscriber-resource`, { address, signMessage: async () => { signed = true; return "0xab"; } }), /domain|origin/i);
  assert.equal(signed, false);
});


test("Agent Wallet signs one bounded root delegation directly to the adapter", async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const merchant = "0x3333333333333333333333333333333333333333" as const;
  const adapter = "0x4444444444444444444444444444444444444444" as const;
  const environment = getSmartAccountsEnvironment(84532);
  const client = new AgentWalletSubscriptionClient({
    getAddress: async () => signer.address,
    signTypedData: input => signer.signTypedData(input as any),
  });
  const context = await client.createPermission({
    record: { ...record, subscriber: signer.address, payer: agreement, merchant, adapter, manager: environment.DelegationManager },
    permission: { startTime: 100, expiry: 200 },
    requirements: { asset: address, amount: "1000000", payTo: merchant,
      extra: { planId: "test", periodDuration: 15, token: { symbol: "SUBTEST", decimals: 18, formattedAmount: "dust" }, cancellationPolicy: "Cancel" } },
    resource: {},
  });
  const [delegation] = decodeDelegations(context);
  assert.equal(decodeDelegations(context).length, 1);
  assert.ok(isAddressEqual(delegation.delegator, agreement));
  assert.ok(isAddressEqual(delegation.delegate, adapter));
  const caveat = (enforcer: string) => delegation.caveats.find(item => isAddressEqual(item.enforcer, enforcer as `0x${string}`))!;
  const periodic = decodeERC20TokenPeriodTransferTerms(caveat(environment.caveatEnforcers.ERC20PeriodTransferEnforcer).terms);
  assert.deepEqual(periodic, { tokenAddress: address, periodAmount: 1000000n, periodDuration: 15, startDate: 100 });
  assert.equal(decodeTimestampTerms(caveat(environment.caveatEnforcers.TimestampEnforcer).terms).beforeThreshold, 200);
  assert.deepEqual(decodeRedeemerTerms(caveat(environment.caveatEnforcers.RedeemerEnforcer).terms).redeemers, [adapter]);
  const payee = decodeAllowedCalldataTerms(caveat(environment.caveatEnforcers.AllowedCalldataEnforcer).terms);
  assert.equal(payee.startIndex, 4);
  assert.equal(payee.value.slice(-40).toLowerCase(), merchant.slice(2).toLowerCase());
});

test("resource URLs allow stable local fixtures without permitting arbitrary HTTP", () => {
  assert.equal(resourceUrl("http://127.0.0.1:4021/subscriber-resource"), "http://127.0.0.1:4021/subscriber-resource");
  assert.equal(resourceUrl("http://192.168.1.23:4021/subscriber-resource"), "http://192.168.1.23:4021/subscriber-resource");
  assert.equal(resourceUrl("http://172.16.0.1:4021/subscriber-resource"), "http://172.16.0.1:4021/subscriber-resource");
  assert.rejects(async () => resourceUrl("http://example.com/subscriber-resource"), /HTTPS/);
});

test("wallet output uses a confirmed receipt and explains the custom call", async () => {
  const hash = `0x${"ab".repeat(32)}` as const;
  const notices: string[] = [];
  const state = { selectedWallet: { mode: "server", namespace: "evm", ref: { address } }, remoteWallets: [{ address }] };
  const ctx = {
    walletStateManager: { read: () => state },
    walletExecutor: async () => async () => ({ kind: "transaction", hash, status: "pending" }),
    publicClient: () => ({ waitForTransactionReceipt: async () => ({ transactionHash: hash, status: "success", blockNumber: 12n }) }),
  };
  const wallet = await subscriptionWallet(ctx as any, { emit: (message: string) => notices.push(message) } as any, "test");
  const call = { function: "bindAgreement(address)", arguments: { agreement: address } };
  assert.deepEqual(await wallet.send(address, "0x", "Bind Agreement", call), {
    status: "success", hash, blockNumber: "12", target: address, ...call,
  });
  assert.ok(notices[0].includes("bindAgreement(address)"));
  assert.ok(notices[1].startsWith("Confirmed transaction:"));
});

test("status discovers the merchant endpoint without requesting a wallet executor", async t => {
  const resource = "http://127.0.0.1:4021/subscriber-resource";
  const statusEndpoint = "http://127.0.0.1:4021/subscriptions/status";
  const expected = { subscription: null, renewalEnabled: null, accessPaid: null, paidThrough: null, latestCollection: null, renewalError: null };
  const challenge = encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: resource },
    accepts: [{ scheme: "shodai-subscription", network: "eip155:84532", asset: address, amount: "1", payTo: address, maxTimeoutSeconds: 600,
      extra: { statusEndpoint } }],
  } as any);
  t.mock.method(globalThis, "fetch", async input => {
    const url = String(input);
    if (url.startsWith(statusEndpoint)) return Response.json(expected);
    return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
  });
  const state = { selectedWallet: { mode: "server", namespace: "evm", ref: { address } }, remoteWallets: [{ address }] };
  const ctx = {
    args: { "resource-url": resource },
    walletStateManager: { read: () => state },
    walletExecutor: () => { throw new Error("Status must not request signing"); },
  };
  assert.deepEqual(await Status.prototype.execute.call({ ctx } as any, {} as any), expected);
});

test("subscribe reuses installed permission and binding, then rejects active or canceled subscriptions", async t => {
  t.mock.method(policyCli, "run", async () => ({
    address,
    policy: yaml.dump({ wallet_address: address, addresses: { allowlist: [{ address: agreement, chain_id: 84532 }], blocklist: [] } }),
  }));
  const resource = "http://127.0.0.1:1234/subscriber-resource";
  let agreementState = keccak256(toBytes("AUTO_RENEW_ON"));
  let paidThrough = 0n;
  let signatures = 0;
  let activations = 0;
  const challenge = encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: resource },
    accepts: [{ scheme: "shodai-subscription", network: "eip155:84532", asset: address, amount: "1000000", payTo: address, maxTimeoutSeconds: 600,
      extra: { planId: "test", periodDuration: 15, token: { symbol: "SUBTEST", decimals: 18, formattedAmount: "0.000000000001" },
        agentWalletSetup: { endpoint: "http://127.0.0.1:1234/setup" } } }],
  } as any);
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    if (input.endsWith("/setup") && init?.method === "POST") return Response.json({ record, permission: { startTime: 100, expiry: 200 } });
    if ((init?.headers as Record<string, string>)?.["PAYMENT-SIGNATURE"]) {
      activations++;
      return Response.json({ access: "granted" });
    }
    return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
  });
  const state = { selectedWallet: { mode: "server", namespace: "evm", ref: { address } }, remoteWallets: [{ address }] };
  const ctx = {
    args: { "resource-url": resource },
    walletStateManager: { read: () => state },
    publicClient: () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "currentState") return agreementState;
        if (functionName === "lastPaidThrough") return paidThrough;
        if (functionName === "agreement") return agreement;
        if (functionName === "permissionContext") return "0x1234";
        throw new Error(`Unexpected read: ${functionName}`);
      },
    }),
    walletExecutor: async () => async (request: { kind: string; typedData: { primaryType: string } }) => {
      assert.equal(request.kind, "typed-data");
      assert.equal(request.typedData.primaryType, "Activation");
      signatures++;
      return { kind: "signature", signature: `0x${"ab".repeat(32)}` };
    },
  };
  const run = () => Subscribe.prototype.execute.call({ ctx, pluginCommandId: "shodai:subscribe" } as any, { emit: () => {} } as any);
  const result = await run();
  assert.ok("alreadyBound" in result.binding && result.binding.alreadyBound);
  assert.equal((result.installation as { alreadyInstalled: boolean }).alreadyInstalled, true);
  assert.equal(signatures, 1);
  assert.equal(activations, 1);
  paidThrough = 30n;
  await assert.rejects(run, (error: any) => error.code === "SUBSCRIPTION_ALREADY_ACTIVATED");
  agreementState = keccak256(toBytes("AUTO_RENEW_OFF"));
  await assert.rejects(run, (error: any) => error.code === "SUBSCRIPTION_CANCELED");
  assert.equal(signatures, 1);
  assert.equal(activations, 1);
});
