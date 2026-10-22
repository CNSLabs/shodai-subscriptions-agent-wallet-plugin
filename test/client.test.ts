import assert from "node:assert/strict";
import { test } from "node:test";
import yaml from "js-yaml";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { decodeAllowedCalldataTerms, decodeAllowedTargetsTerms, decodeDelegations, decodeERC20TokenPeriodTransferTerms, decodeNativeTokenPeriodTransferTerms, decodeRedeemerTerms, decodeTimestampTerms } from "@metamask/delegation-core";
import { buildSIWxSchema } from "@x402/extensions/sign-in-with-x";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { isAddressEqual, keccak256, pad, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { resourceUrl, subscriptionWallet } from "../src/wallet.js";
import { accessResource } from "../src/access.js";
import { AgentWalletSubscriptionClient } from "../src/subscription-client.js";
import { NATIVE_ETH_ASSET } from "../src/protocol.js";
import { selectOffer } from "../src/offer.js";
import { requestInit, resourceRequest } from "../src/request.js";
import { collectionOutcome } from "../src/http.js";
import type { SubscriptionRecord } from "../src/protocol.js";
import { ensureAgreementTrust, policyCli } from "../src/trust.js";
import Access from "../src/commands/shodai/access.js";
import Cancel from "../src/commands/shodai/cancel.js";
import Subscribe, { smartAccountPublicClient } from "../src/commands/shodai/subscribe.js";
import Status from "../src/commands/shodai/status.js";

const address = "0x1111111111111111111111111111111111111111";
const agreement = "0x2222222222222222222222222222222222222222";
const record: SubscriptionRecord = { id: "test", planId: "test", subscriber: address, payer: agreement,
  merchant: address, agreement, adapter: address, manager: address, enforcer: address };
const io = { notify: () => {}, emit: () => {} } as any;
const siwx = (resource: string, chainId = 84532) => ({ "sign-in-with-x": {
  info: { domain: new URL(resource).host, uri: resource, version: "1", nonce: "abcdef0123456789", issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 300_000).toISOString() },
  supportedChains: [{ chainId: `eip155:${chainId}`, type: "eip191" }], schema: buildSIWxSchema(),
} });

test("subscribe help describes the direct Agent Wallet journey", () => {
  assert.match(Subscribe.description, /selected Agent Wallet/);
  assert.match(Subscribe.description, /bounded recurring-payment permission/);
});

test("smart account derivation receives the verified chain when the CLI RPC client is chainless", () => {
  const chainless = { chain: undefined, getChainId: async () => 84532 } as any;
  assert.equal(smartAccountPublicClient(chainless, 84532).chain.id, 84532);
  assert.throws(() => smartAccountPublicClient({ chain: { id: 1 } } as any, 84532), /chain mismatch/);
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
  assert.equal((await ensureAgreementTrust(address, agreement, 84532, io)).alreadyTrusted, false);
  assert.deepEqual(policy, { ...baseline, addresses: { ...baseline.addresses,
    allowlist: [...baseline.addresses.allowlist, { address: agreement, chain_id: 84532 }] } });
  assert.equal((await ensureAgreementTrust(address, agreement, 84532, io)).alreadyTrusted, true);
  assert.equal(writes, 1);
});

test("message uses the stock executor API; cross-origin SIWx fails before signing", async t => {
  const origin = "https://subscription.example";
  const signer = privateKeyToAccount(generatePrivateKey());
  const ctx = { walletStateManager: { read: () => ({ selectedWallet: { namespace: "evm", mode: "server", ref: { address: signer.address } }, remoteWallets: [{ address: signer.address }] }) },
    walletExecutor: async () => async (request: any) => {
      assert.deepEqual(request, { kind: "message", chainId: 84532, message: "message",
        intent: { action: "custom", summary: "Authenticate subscription resource access" } });
      return { kind: "signature", signature: await signer.signMessage({ message: request.message }) };
    } };
  const wallet = await subscriptionWallet(ctx as any, io, "test");
  assert.ok((await wallet.signMessage("message", 84532)).startsWith("0x"));
  let signed = false;
  const offer = { x402Version: 2, resource: { url: `${origin}/subscriber-resource` }, accepts: [{
    scheme: "shodai-subscription", network: "eip155:84532", asset: NATIVE_ETH_ASSET, amount: "1", payTo: address,
    extra: { version: "1", planId: "test", periodDuration: 60, agentWalletSetup: { endpoint: `${origin}/setup` } },
  }], extensions: { ...siwx(`${origin}/subscriber-resource`), "sign-in-with-x": { ...siwx(`${origin}/subscriber-resource`)["sign-in-with-x"], info: {
    ...siwx(`${origin}/subscriber-resource`)["sign-in-with-x"].info, uri: "https://other.example/resource" } } } };
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(offer as any) } }));
  await assert.rejects(() => accessResource(`${origin}/subscriber-resource`, { address, signMessage: async () => { signed = true; return "0xab"; } }), /authentication/i);
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
  await assert.rejects(() => wallet.signMessage("challenge", 84532), /different wallet/);
  selected = second.address;
  await assert.rejects(() => wallet.signMessage("challenge", 84532), /Selected wallet changed/);
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
    offer: { chainId: 84532, native: true } as any,
    proof: "unused",
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
  assert.deepEqual(await wallet.send(84532, address, "0x", "Bind Agreement", call), {
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
      extra: { version: "1", planId: "test", periodDuration: 60, agentWalletSetup: { endpoint: `${new URL(resource).origin}/setup` }, statusEndpoint } }], extensions: siwx(resource),
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

test("status discovery is GET-only even when stale write flags are present", async t => {
  const resource = "https://merchant.example/resource";
  const statusEndpoint = "https://merchant.example/status";
  const offer = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: resource },
    accepts: [{ scheme: "shodai-subscription", network: "eip155:84532", asset: NATIVE_ETH_ASSET, amount: "1", payTo: address,
      extra: { version: "1", planId: "test", periodDuration: 60, agentWalletSetup: { endpoint: "/setup" }, statusEndpoint } }],
    extensions: siwx(resource) } as any);
  t.mock.method(globalThis, "fetch", async (input, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.body, undefined);
    return String(input).startsWith(statusEndpoint) ? Response.json({ subscription: null }) :
      new Response("{}", { status: 402, headers: { "payment-required": offer } });
  });
  const ctx = { args: { "resource-url": resource }, flags: { method: "POST", body: "{}" },
    walletStateManager: { read: () => ({ selectedWallet: { mode: "server", namespace: "evm", ref: { address } }, remoteWallets: [{ address }] }) } };
  assert.deepEqual(await Status.prototype.execute.call({ ctx } as any, {} as any), { subscription: null });
});

test("POST discovery preserves method and body through authenticated setup", async t => {
  const resource = "http://127.0.0.1:1234/v0/agreements/deploy-with-permit";
  const setup = "http://127.0.0.1:1234/v0/subscriptions/setup";
  const body = JSON.stringify({ agreement: { title: "A" }, parties: [address, agreement] });
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const offer = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: resource },
    accepts: [{ scheme: "shodai-subscription", network: "eip155:84532", asset: NATIVE_ETH_ASSET,
      amount: "1000000000", payTo: address, maxTimeoutSeconds: 600,
      extra: { version: "1", planId: "test", periodDuration: 60, agentWalletSetup: { endpoint: setup } } }], extensions: siwx(resource) } as any);
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    calls.push({ url: input, method: init?.method, body: init?.body as string | undefined });
    if (input === resource) return new Response("{}", { status: 402, headers: { "payment-required": offer } });
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
  assert.equal(calls[1].url, resource);
  assert.equal(calls[2].url, setup);
  assert.equal((JSON.parse(calls[2].body!) as { agentWallet: string }).agentWallet, address);
  assert.deepEqual(requestInit(resourceRequest({ method: "POST", body })).body, body);
});

test("offer selection accepts ERC-20 on another EVM chain and rejects ambiguous or malformed offers", () => {
  const resource = "https://merchant.example/subscriber-resource";
  const requirement = { scheme: "shodai-subscription", network: "eip155:8453", asset: address, amount: "1234567", payTo: agreement,
    maxTimeoutSeconds: 600, extra: { version: "1", planId: "erc20", periodDuration: 3600,
      agentWalletSetup: { endpoint: "/subscriptions/setup" }, statusEndpoint: "/subscriptions/status" } };
  const extension = siwx(resource, 8453);
  const header = (accepts: unknown[], extensions: unknown = extension) => encodePaymentRequiredHeader({
    x402Version: 2, resource: { url: resource }, accepts, extensions,
  } as any);
  assert.deepEqual(selectOffer(header([requirement]), resource), {
    requirement, resource: { url: resource }, chainId: 8453, native: false,
    setupUrl: "https://merchant.example/subscriptions/setup", statusUrl: "https://merchant.example/subscriptions/status",
    siwx: extension["sign-in-with-x"],
  });
  assert.throws(() => selectOffer(header([requirement, requirement]), resource), /Ambiguous/);
  assert.throws(() => selectOffer(header([{ ...requirement, amount: "0" }]), resource), /No compatible/);
  assert.throws(() => selectOffer(header([{ ...requirement, extra: { ...requirement.extra, agentWalletSetup: { endpoint: "https://other.example/setup" } } }]), resource), /No compatible/);
  assert.throws(() => selectOffer(header([requirement], {}), resource), /No compatible/);
});

test("ERC-20 permission binds token, period, adapter, and recipient calldata", async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const chainId = 8453;
  const environment = getSmartAccountsEnvironment(chainId);
  const start = Math.floor(Date.now() / 1000);
  const merchant = "0x3333333333333333333333333333333333333333" as const;
  const adapter = "0x4444444444444444444444444444444444444444" as const;
  const client = new AgentWalletSubscriptionClient({ getAddress: async () => signer.address,
    signMessage: message => signer.signMessage({ message }), signTypedData: input => signer.signTypedData(input as any) });
  const context = await client.createPermission({ record: { ...record, subscriber: signer.address, merchant, adapter,
    manager: environment.DelegationManager }, permission: { startTime: start, expiry: start + 300 },
    requirements: { asset: address, amount: "1234567", payTo: merchant, extra: { periodDuration: 60 } },
    resource: {}, offer: { chainId, native: false } as any, proof: "unused" });
  const [delegation] = decodeDelegations(context);
  const caveat = (enforcer: string) => delegation.caveats.find(item => isAddressEqual(item.enforcer, enforcer as `0x${string}`))!;
  assert.deepEqual(decodeERC20TokenPeriodTransferTerms(caveat(environment.caveatEnforcers.ERC20PeriodTransferEnforcer).terms),
    { tokenAddress: address, periodAmount: 1234567n, periodDuration: 60, startDate: start });
  assert.deepEqual(decodeAllowedCalldataTerms(caveat(environment.caveatEnforcers.AllowedCalldataEnforcer).terms),
    { startIndex: 4, value: pad(merchant) });
});

test("SIWx-only retry returns covered content without setup", async t => {
  const resource = "https://merchant.example/subscriber-resource";
  const offer = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: resource },
    accepts: [{ scheme: "shodai-subscription", network: "eip155:84532", asset: NATIVE_ETH_ASSET, amount: "1", payTo: address,
      maxTimeoutSeconds: 600, extra: { version: "1", planId: "native", periodDuration: 60, agentWalletSetup: { endpoint: "/setup" } } }],
    extensions: siwx(resource) } as any);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input, init?: RequestInit) => {
    calls++;
    if (calls === 1) return new Response("{}", { status: 402, headers: { "payment-required": offer } });
    assert.ok((init?.headers as Record<string, string>)["SIGN-IN-WITH-X"]);
    return new Response("covered", { status: 200 });
  });
  const client = new AgentWalletSubscriptionClient({ getAddress: async () => address, signMessage: async () => "0xab", signTypedData: async () => "0xab" });
  const result = await client.begin(resource);
  assert.ok("alreadyCovered" in result);
  assert.equal(calls, 2);
});

test("access and subscribe authenticate existing paid coverage with no purchase offer", async t => {
  const resource = "https://merchant.example/subscriber-resource";
  const challenge = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: resource }, accepts: [], extensions: siwx(resource) } as any);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), resource);
    assert.equal(init?.redirect, "error");
    calls++;
    if (!(init?.headers as Record<string, string>)["SIGN-IN-WITH-X"]) return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
    return new Response("covered", { status: 200 });
  });
  const wallet = { address, getAddress: async () => address, signMessage: async () => "0xab" as const, signTypedData: async () => { throw new Error("No payment signature"); } };
  assert.equal((await accessResource(resource, wallet)).content, "covered");
  const started = await new AgentWalletSubscriptionClient(wallet).begin(resource);
  assert.ok("alreadyCovered" in started);
  assert.equal(calls, 4);
});

test("authentication refresh preserves the signed collection header and original operation without setup", async t => {
  const resource = "https://merchant.example/subscriber-resource";
  const body = '{"action":"create"}';
  const challenge = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: resource }, accepts: [], extensions: siwx(resource) } as any);
  const calls: RequestInit[] = [];
  let messages = 0;
  const client = new AgentWalletSubscriptionClient({ getAddress: async () => address,
    signMessage: async () => { messages++; return "0xab"; }, signTypedData: async () => { throw new Error("Collection must retain its existing signature"); } },
    async (input, init) => {
      assert.equal(String(input), resource); calls.push(init!);
      if (calls.length === 1) return new Response("Invalid or expired SIGN-IN-WITH-X proof", { status: 401 });
      if (calls.length < 4) return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
      return Response.json({ code: "subscription_payment_pending", subscriptionId: "subscription", paymentId: "payment" }, { status: 503 });
    });
  t.mock.method(client, "begin", async () => { throw new Error("Refresh must not invoke setup"); });
  const response = await client.requestAuthorizedResource(resource, { method: "POST", body }, "old-proof", "unchanged-signed-message");
  assert.deepEqual(await collectionOutcome(response), { outcome: "pending", subscriptionId: "subscription", paymentId: "payment" });
  assert.equal(messages, 1);
  for (const init of calls) { assert.equal(init.method, "POST"); assert.equal(init.body, body); assert.equal(init.redirect, "error"); }
  assert.equal((calls[0].headers as Record<string, string>)["PAYMENT-SIGNATURE"], (calls[3].headers as Record<string, string>)["PAYMENT-SIGNATURE"]);
  assert.equal((calls[1].headers as Record<string, string>)["PAYMENT-SIGNATURE"], undefined);
  assert.equal((calls[2].headers as Record<string, string>)["PAYMENT-SIGNATURE"], undefined);
});

test("status discovery stays read-only with closed Plans and unrelated purchase offers", async t => {
  const resource = "https://merchant.example/subscriber-resource";
  const endpoint = "https://merchant.example/status?product=reference";
  const challenge = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: resource },
    accepts: [{ scheme: "exact", network: "eip155:84532", asset: NATIVE_ETH_ASSET, amount: "1", payTo: address, maxTimeoutSeconds: 600 }],
    extensions: { "shodai-subscription": { version: "1", statusEndpoint: endpoint } } } as any);
  const expected = { subscription: { id: "retained", planId: "closed-plan", network: "eip155:84532", subscriber: address, merchant: address, payer: null, agreement: null, adapter: null },
    renewalEnabled: null, accessPaid: null, paidThrough: null, latestCollection: null, renewalError: null };
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method ?? "GET", "GET"); assert.equal(init?.body, undefined); assert.equal(init?.redirect, "error");
    if (url.pathname === "/status") {
      assert.equal(url.searchParams.get("product"), "reference"); assert.equal(url.searchParams.get("subscriber"), address);
      return Response.json(expected);
    }
    return new Response("{}", { status: 402, headers: { "payment-required": challenge } });
  });
  const ctx = { args: { "resource-url": resource }, walletStateManager: { read: () => ({ selectedWallet: { mode: "server", namespace: "evm", ref: { address } }, remoteWallets: [{ address }] }) },
    walletExecutor: () => { throw new Error("Status must not request signing or transactions"); } };
  assert.deepEqual(await Status.prototype.execute.call({ ctx } as any, {} as any), expected);
});

test("known collection outcomes remain distinct from resource access and transport failure", async () => {
  assert.deepEqual(await collectionOutcome(Response.json({ code: "subscription_service_unavailable" }, { status: 503 })), { outcome: "unavailable" });
  assert.deepEqual(await collectionOutcome(Response.json({ code: "subscription_payment_failed", subscriptionId: "s", paymentId: "p", message: "Collection failed" }, { status: 503 })),
    { outcome: "failed", subscriptionId: "s", paymentId: "p", message: "Collection failed" });
  assert.equal(await collectionOutcome(Response.json({ message: "other failure" }, { status: 503 })), undefined);
  assert.equal(await collectionOutcome(new Response("resource", { status: 200 })), undefined);
});
