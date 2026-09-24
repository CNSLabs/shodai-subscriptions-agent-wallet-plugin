import assert from "node:assert/strict";
import { test } from "node:test";
import yaml from "js-yaml";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { decodeAllowedTargetsTerms, decodeDelegations, decodeNativeTokenPeriodTransferTerms, decodeRedeemerTerms, decodeTimestampTerms } from "@metamask/delegation-core";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { isAddressEqual, keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { resourceUrl, subscriptionWallet } from "../src/wallet.js";
import { accessResource } from "../src/access.js";
import { AgentWalletSubscriptionClient } from "../src/subscription-client.js";
import { NATIVE_ETH_ASSET } from "../src/protocol.js";
import { requestInit, resourceRequest } from "../src/request.js";
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

test("message uses the stock executor API; cross-origin wallet challenge fails before signing", async t => {
  const origin = "https://subscription.example";
  const signer = privateKeyToAccount(generatePrivateKey());
  const ctx = { walletStateManager: { read: () => ({ selectedWallet: { namespace: "evm", mode: "server", ref: { address: signer.address } }, remoteWallets: [{ address: signer.address }] }) },
    walletExecutor: async () => async (request: any) => {
      assert.deepEqual(request, { kind: "message", chainId: 84532, message: "message",
        intent: { action: "custom", summary: "Authenticate subscription resource access" } });
      return { kind: "signature", signature: await signer.signMessage({ message: request.message }) };
    } };
  const wallet = await subscriptionWallet(ctx as any, io, "test");
  assert.ok((await wallet.signMessage("message")).startsWith("0x"));
  let signed = false;
  const offer = { x402Version: 2, resource: { url: `${origin}/subscriber-resource` }, accepts: [{
    scheme: "shodai-subscription", network: "eip155:84532", asset: NATIVE_ETH_ASSET, amount: "1", payTo: address,
    extra: { challengeEndpoint: "https://other.example/challenge" },
  }] };
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(offer as any) } }));
  await assert.rejects(() => accessResource(`${origin}/subscriber-resource`, { address, signMessage: async () => { signed = true; return "0xab"; } }), /origin/i);
  assert.equal(signed, false);
});

test("rejects a wallet selection change before signing and a mismatched executor signature", async () => {
  const first = privateKeyToAccount(generatePrivateKey());
  const second = privateKeyToAccount(generatePrivateKey());
  let selected = first.address;
  const ctx = { walletStateManager: { read: () => ({ selectedWallet: { namespace: "evm", mode: "server", ref: { address: selected } },
    remoteWallets: [{ address: first.address }, { address: second.address }] }) },
  walletExecutor: async () => async ({ message }: { message: string }) => ({ kind: "signature", signature: await second.signMessage({ message }) }) };
  const wallet = await subscriptionWallet(ctx as any, io, "test");
  await assert.rejects(() => wallet.signMessage("challenge"), /different wallet/);
  selected = second.address;
  await assert.rejects(() => wallet.signMessage("challenge"), /Selected wallet changed/);
});


test("Agent Wallet signs one bounded root delegation directly to the adapter", async () => {
  const start = Math.floor(Date.now() / 1000);
  const expiry = start + 100;
  const signer = privateKeyToAccount(generatePrivateKey());
  const merchant = "0x3333333333333333333333333333333333333333" as const;
  const adapter = "0x4444444444444444444444444444444444444444" as const;
  const environment = getSmartAccountsEnvironment(84532);
  const client = new AgentWalletSubscriptionClient({
    getAddress: async () => signer.address,
    signMessage: message => signer.signMessage({ message }),
    signTypedData: input => signer.signTypedData(input as any),
  });
  const context = await client.createPermission({
    record: { ...record, subscriber: signer.address, payer: agreement, merchant, adapter, manager: environment.DelegationManager },
    permission: { startTime: start, expiry },
    requirements: { asset: NATIVE_ETH_ASSET, amount: "1000000", payTo: merchant,
      extra: { planId: "test", periodDuration: 15, token: { symbol: "SUBTEST", decimals: 18, formattedAmount: "dust" }, cancellationPolicy: "Cancel" } },
    resource: {},
  });
  const [delegation] = decodeDelegations(context);
  assert.equal(decodeDelegations(context).length, 1);
  assert.ok(isAddressEqual(delegation.delegator, agreement));
  assert.ok(isAddressEqual(delegation.delegate, adapter));
  const caveat = (enforcer: string) => delegation.caveats.find(item => isAddressEqual(item.enforcer, enforcer as `0x${string}`))!;
  const periodic = decodeNativeTokenPeriodTransferTerms(caveat(environment.caveatEnforcers.NativeTokenPeriodTransferEnforcer).terms);
  assert.deepEqual(periodic, { periodAmount: 1000000n, periodDuration: 15, startDate: start });
  assert.equal(decodeTimestampTerms(caveat(environment.caveatEnforcers.TimestampEnforcer).terms).beforeThreshold, expiry);
  assert.deepEqual(decodeRedeemerTerms(caveat(environment.caveatEnforcers.RedeemerEnforcer).terms).redeemers, [adapter]);
  const payee = decodeAllowedTargetsTerms(caveat(environment.caveatEnforcers.AllowedTargetsEnforcer).terms);
  assert.deepEqual(payee.targets, [merchant]);
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

test("POST discovery preserves method and body through authenticated setup", async t => {
  const resource = "http://127.0.0.1:1234/v0/agreements/deploy-with-permit";
  const setup = "http://127.0.0.1:1234/v0/subscriptions/setup";
  const challengeEndpoint = "http://127.0.0.1:1234/v0/subscriptions/challenge";
  const body = JSON.stringify({ agreement: { title: "A" }, parties: [address, agreement] });
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const offer = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: resource },
    accepts: [{ scheme: "shodai-subscription", network: "eip155:84532", asset: NATIVE_ETH_ASSET,
      amount: "1000000000", payTo: address, maxTimeoutSeconds: 600,
      extra: { planId: "test", periodDuration: 60, challengeEndpoint, agentWalletSetup: { endpoint: setup } } }] } as any);
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    calls.push({ url: input, method: init?.method, body: init?.body as string | undefined });
    if (input === resource) return new Response("{}", { status: 402, headers: { "payment-required": offer } });
    if (input === challengeEndpoint) {
      const challenged = JSON.parse(init?.body as string);
      return Response.json({ challengeId: "one", message: `Resource: ${challenged.resource}` });
    }
    if (input === setup) return Response.json({ record, permission: { startTime: 100, expiry: 200 } });
    throw new Error(`Unexpected URL: ${input}`);
  });
  const client = new AgentWalletSubscriptionClient({
    getAddress: async () => address,
    signMessage: async () => "0xab",
    signTypedData: async () => "0xab",
  });
  const result = await client.begin(resource, { method: "POST", body });
  assert.ok(!("alreadyCovered" in result));
  assert.deepEqual(calls[0], { url: resource, method: "POST", body });
  assert.equal(calls[1].url, challengeEndpoint);
  assert.equal(calls[2].url, setup);
  assert.equal((JSON.parse(calls[2].body!) as { agentWallet: string }).agentWallet, address);
  assert.deepEqual(requestInit(resourceRequest({ method: "POST", body })).body, body);
});
