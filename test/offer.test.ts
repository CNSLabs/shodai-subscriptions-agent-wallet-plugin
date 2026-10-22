import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { decodeAllowedCalldataTerms, decodeDelegations, decodeERC20TokenPeriodTransferTerms } from "@metamask/delegation-core";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { isAddressEqual } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { discoverStatus, selectAuthentication, selectOffer } from "../src/offer.js";
import { AgentWalletSubscriptionClient } from "../src/subscription-client.js";
import { NATIVE_ETH_ASSET } from "../src/protocol.js";

const origin = "https://resource.example";
const url = `${origin}/subscriber-resource`;
const merchant = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const payer = "0x3333333333333333333333333333333333333333";
const adapter = "0x4444444444444444444444444444444444444444";

function offer(asset = NATIVE_ETH_ASSET, chainId = 84532) {
  const now = Date.now();
  return { x402Version: 2, resource: { url }, accepts: [{ scheme: "shodai-subscription", network: `eip155:${chainId}`,
    asset, amount: "1000000", payTo: merchant, maxTimeoutSeconds: 600,
    extra: { version: "1", planId: "plan", periodDuration: 60,
      agentWalletSetup: { endpoint: `${origin}/subscriptions/setup` }, statusEndpoint: `${origin}/subscriptions/status` } }],
    extensions: { "sign-in-with-x": { info: { domain: "resource.example", uri: url, version: "1",
      nonce: "a".repeat(32), issuedAt: new Date(now).toISOString(), expirationTime: new Date(now + 600_000).toISOString() },
      supportedChains: [{ chainId: `eip155:${chainId}`, type: "eip191" }], schema: {} } } };
}

test("native and ERC-20 offers keep asset and chain independent", () => {
  const native = selectOffer(encodePaymentRequiredHeader(offer() as any), url);
  const erc20 = selectOffer(encodePaymentRequiredHeader(offer(token, 8453) as any), url);
  assert.deepEqual([native.native, native.chainId], [true, 84532]);
  assert.deepEqual([erc20.native, erc20.chainId, erc20.requirement.asset], [false, 8453, token]);
});

test("SIWx offer lifetime matches the wallet approval window", () => {
  assert.doesNotThrow(() => selectOffer(encodePaymentRequiredHeader(offer() as any), url));
  const tooLong = offer();
  tooLong.extensions["sign-in-with-x"].info.expirationTime = new Date(
    Date.parse(tooLong.extensions["sign-in-with-x"].info.issuedAt) + 600_001,
  ).toISOString();
  assert.throws(() => selectOffer(encodePaymentRequiredHeader(tooLong as any), url), /compatible/);
});

test("ambiguous, wrong-origin, and malformed offers fail before signing", () => {
  const cases = [
    { ...offer(), accepts: [...offer().accepts, ...offer().accepts] },
    { ...offer(), resource: { url: `${origin}/different` } },
    { ...offer(), accepts: [{ ...offer().accepts[0], amount: "0" }] },
    { ...offer(), accepts: [{ ...offer().accepts[0], extra: { ...offer().accepts[0].extra, agentWalletSetup: { endpoint: "https://evil.example/setup" } } }] },
    { ...offer(), extensions: {} },
  ];
  for (const value of cases) assert.throws(() => selectOffer(encodePaymentRequiredHeader(value as any), url));
});

test("unsupported chain fails before SIWx approval or setup", async () => {
  let signed = false;
  let setup = false;
  const header = encodePaymentRequiredHeader(offer(token, 8453) as any);
  const client = new AgentWalletSubscriptionClient({
    getAddress: async () => merchant,
    signMessage: async () => { signed = true; return "0x"; },
    signTypedData: async () => "0x",
  }, async (input) => {
    if (String(input).endsWith("/subscriptions/setup")) setup = true;
    return new Response("{}", { status: 402, headers: { "payment-required": header } });
  }, async () => { throw new Error("Unsupported chain"); });
  await assert.rejects(() => client.begin(url), /Unsupported chain/);
  assert.equal(signed, false);
  assert.equal(setup, false);
});

test("authenticated retry revalidates current price and preserves the original POST", async () => {
  const first = encodePaymentRequiredHeader(offer() as any);
  const revised = offer();
  revised.accepts[0].amount = "2000000";
  const current = encodePaymentRequiredHeader(revised as any);
  const body = JSON.stringify({ action: "create" });
  const calls: Array<{ url: string; method?: string; body?: string; proof?: string }> = [];
  const client = new AgentWalletSubscriptionClient({
    getAddress: async () => merchant,
    signMessage: async () => "0x",
    signTypedData: async () => "0x",
  }, async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ url: String(input), method: init?.method, body: init?.body as string | undefined,
      proof: headers?.["SIGN-IN-WITH-X"] });
    if (calls.length === 1) return new Response("{}", { status: 402, headers: { "payment-required": first } });
    if (calls.length === 2) return new Response("{}", { status: 402, headers: { "payment-required": current } });
    return Response.json({ record: { id: "record", planId: "plan", subscriber: merchant, payer, merchant,
      agreement: payer, adapter, manager: merchant, enforcer: merchant, status: "pending" },
      permission: { startTime: 1, expiry: 2 } });
  });
  const result = await client.begin(url, { method: "POST", body });
  assert.ok(!("alreadyCovered" in result));
  assert.equal(result.requirements.amount, "2000000");
  assert.deepEqual(calls.slice(0, 2).map(call => [call.url, call.method, call.body]), [[url, "POST", body], [url, "POST", body]]);
  assert.equal(calls[1].proof, calls[2].proof);
  assert.equal(calls[2].url, `${origin}/subscriptions/setup`);
});

test("an authenticated continuation offer discovers setup after a Plan has closed", async () => {
  const initial = encodePaymentRequiredHeader({ ...offer(), accepts: [] } as any);
  const continuation = offer();
  continuation.accepts[0].extra.planId = "closed-plan";
  const current = encodePaymentRequiredHeader(continuation as any);
  let calls = 0;
  const client = new AgentWalletSubscriptionClient({ getAddress: async () => merchant,
    signMessage: async () => "0xab", signTypedData: async () => { throw new Error("Setup does not authorize payment"); } }, async (input, init) => {
    calls++;
    if (calls <= 2) return new Response("{}", { status: 402, headers: { "payment-required": calls === 1 ? initial : current } });
    assert.equal(String(input), `${origin}/subscriptions/setup`);
    assert.deepEqual(JSON.parse(init!.body as string), { planId: "closed-plan", agentWallet: merchant });
    return Response.json({ record: { id: "retained", planId: "closed-plan", subscriber: merchant, payer, merchant, agreement: payer, adapter, manager: merchant, enforcer: merchant },
      permission: { startTime: 1, expiry: 86401 } });
  });
  const started = await client.begin(url);
  assert.ok(!("alreadyCovered" in started));
  assert.equal(started.record.id, "retained");
  assert.equal(calls, 3);
});

test("ERC-20 delegation constrains token, amount, period, and recipient calldata", async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const chainId = 84532;
  const environment = getSmartAccountsEnvironment(chainId);
  const selected = selectOffer(encodePaymentRequiredHeader(offer(token, chainId) as any), url);
  const client = new AgentWalletSubscriptionClient({ getAddress: async () => signer.address,
    signMessage: async message => signer.signMessage({ message }), signTypedData: async input => signer.signTypedData(input as any) });
  const startTime = Math.floor(Date.now() / 1000);
  const context = await client.createPermission({ offer: selected, proof: "proof", requirements: selected.requirement,
    resource: selected.resource,
    record: { id: "record", planId: "plan", subscriber: signer.address, payer, merchant, agreement: payer,
      adapter, manager: environment.DelegationManager, enforcer: environment.caveatEnforcers.ERC20PeriodTransferEnforcer },
    permission: { startTime, expiry: startTime + 3600 } });
  const [delegation] = decodeDelegations(context);
  const period = delegation.caveats.find(item => isAddressEqual(item.enforcer, environment.caveatEnforcers.ERC20PeriodTransferEnforcer))!;
  assert.deepEqual(decodeERC20TokenPeriodTransferTerms(period.terms), {
    tokenAddress: token, periodAmount: 1000000n, periodDuration: 60, startDate: startTime,
  });
  const recipient = delegation.caveats.find(item => isAddressEqual(item.enforcer, environment.caveatEnforcers.AllowedCalldataEnforcer))!;
  const terms = decodeAllowedCalldataTerms(recipient.terms);
  assert.equal(terms.startIndex, 4);
  assert.equal(terms.value.toLowerCase(), `0x${"0".repeat(24)}${merchant.slice(2).toLowerCase()}`);
});

test("independent authentication validates resource, timing and EVM signing before offer selection", () => {
  const noOffer = { ...offer(), accepts: [] };
  assert.equal(selectAuthentication(encodePaymentRequiredHeader(noOffer as any), url).chainId, 84532);
  for (const patch of [
    { domain: "other.example" }, { uri: `${url}/other` }, { nonce: "" },
    { issuedAt: new Date(Date.now() + 31_000).toISOString() },
    { issuedAt: new Date(Date.now() - 601_000).toISOString() },
    { expirationTime: new Date(Date.now() - 1).toISOString() }, { version: "2" },
  ]) {
    const invalid = offer();
    Object.assign(invalid.extensions["sign-in-with-x"].info, patch);
    assert.throws(() => selectAuthentication(encodePaymentRequiredHeader(invalid as any), url));
  }
});

test("invalid resource-level status cannot fall back to a purchase offer", () => {
  for (const metadata of [null, { version: "2", statusEndpoint: "/status" },
    { version: "1", statusEndpoint: "https://other.example/status" },
    { version: "1", statusEndpoint: "https://user:password@resource.example/status" },
    { version: "1", statusEndpoint: "/status#fragment" }]) {
    const invalid = { ...offer(), extensions: { ...offer().extensions, "shodai-subscription": metadata } };
    assert.throws(() => discoverStatus(encodePaymentRequiredHeader(invalid as any), url));
  }
  const legacy = { ...offer(), extensions: {} };
  assert.equal(discoverStatus(encodePaymentRequiredHeader(legacy as any), url), `${origin}/subscriptions/status`);
});
