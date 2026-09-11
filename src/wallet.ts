import type { CommandIO, PluginCommandContext } from "@metamask/agent-wallet/plugin";
import { getAddress, type Address, type Hex } from "viem";
import type { SubscriptionWallet } from "./subscription-client.js";

export const CHAIN_ID = 84532;

export function selectedAddress(ctx: PluginCommandContext): Address {
  const state = ctx.walletStateManager.read();
  const selected = state.selectedWallet;
  if (!selected || selected.namespace !== "evm") throw new Error("Select an EVM Agent Wallet before subscribing");
  const wallets = selected.mode === "server" ? state.remoteWallets : state.byokWallets;
  const ref = selected.ref;
  const wallet = wallets.find(w =>
    ("address" in ref && w.address?.toLowerCase() === ref.address.toLowerCase()) ||
    ("id" in ref && "id" in w && w.id === ref.id) ||
    ("name" in ref && w.name === ref.name));
  return getAddress(wallet?.address ?? ("address" in ref ? ref.address : ""));
}

export async function subscriptionWallet(ctx: PluginCommandContext, io: CommandIO, source: string) {
  const address = selectedAddress(ctx);
  const execute = await ctx.walletExecutor(io, source, { emitStepNotices: true });
  const options = { signal: io.signal, waitForReceipt: true };
  const signer: SubscriptionWallet = {
    getAddress: async () => address,
    signTypedData: async ({ chainId, domain, types, primaryType, message, intent }) => {
      io.emit(intent);
      const result = await execute({ kind: "typed-data", chainId, intent: { action: "custom", summary: intent },
        typedData: JSON.parse(JSON.stringify({ domain, types, primaryType, message }, bigintJson)),
      }, options);
      if (result.kind !== "signature" || !result.signature) throw new Error(result.failureDescription ?? `Signing ended with ${result.status}; job ${result.pendingJob?.pollingId ?? "unknown"}`);
      return result.signature as Hex;
    },
  };
  return {
    ...signer,
    address,
    signMessage: async (message: string) => {
      const result = await execute({ kind: "message", chainId: CHAIN_ID, message, intent: { action: "custom", summary: "Authenticate subscription resource access" } }, options);
      if (result.kind !== "signature" || !result.signature) throw new Error(result.failureDescription ?? `Signing ended with ${result.status}`);
      return result.signature as Hex;
    },
    send: async (to: Address, data: Hex, summary: string, call: { function: string; arguments: Record<string, unknown> }) => {
      io.emit(`${summary}: ${JSON.stringify({ target: to, ...call }, bigintJson)}`);
      const result = await execute({ kind: "transaction", chainId: CHAIN_ID, transaction: { to, data, value: 0n }, intent: { action: "call", summary } }, options);
      if (result.kind !== "transaction" || !result.hash) throw new Error(result.failureDescription ?? `Transaction ended with ${result.status}; job ${result.pendingJob?.pollingId ?? "unknown"}`);
      const receipt = await ctx.publicClient(CHAIN_ID).waitForTransactionReceipt({ hash: result.hash as Hex });
      if (receipt.status !== "success") throw new Error(`Transaction reverted: ${result.hash}`);
      const confirmed = { status: receipt.status, hash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), target: to, ...call };
      io.emit(`Confirmed transaction: ${JSON.stringify(confirmed, bigintJson)}`);
      return confirmed;
    },
  };
}

export function resourceUrl(value: unknown): string {
  const url = new URL(String(value));
  const octets = url.hostname.split(".").map(Number);
  const privateIpv4 = octets.length === 4 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  const localHttp = url.protocol === "http:" && (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || privateIpv4);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Resource must use HTTPS (HTTP is allowed only for loopback or private-LAN development)");
  }
  return url.href;
}

export function bigintJson(_key: string, value: unknown) { return typeof value === "bigint" ? value.toString() : value; }
