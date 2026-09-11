import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CommandError, type CommandIO } from "@metamask/agent-wallet/plugin";
import yaml from "js-yaml";
import { getAddress, type Address } from "viem";
import { CHAIN_ID } from "./wallet.js";

type PolicyEntry = { address: string; chain_id: number };
type Policy = { wallet_address: string; addresses: { allowlist: PolicyEntry[]; blocklist: PolicyEntry[] } };
type PolicyResult = { address?: string; policy?: string; status?: string; requestId?: string };

function parseOutput(stdout: string, stderr = "", exit: number | null = 0): PolicyResult {
  const documents = (text: string): any[] => {
    try { return [JSON.parse(text)]; }
    catch { return text.trim().split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  };
  const output = documents(stdout);
  const failure = [...documents(stderr), ...output].reverse().find(event => event._error || event.ok === false);
  if (failure) {
    const error = failure._error ?? failure.error;
    throw new CommandError(error.code ?? "SUBSCRIPTION_POLICY_FAILED", error.message, error.hint ?? "Inspect the wallet policy request before retrying.");
  }
  if (exit !== 0) throw new Error(stderr.trim() || `Wallet policy command exited ${exit}`);
  const result = output.reverse().find(event => event._summary || event.data);
  if (!result) throw new Error("Wallet policy command returned no result");
  return result._summary ?? result.data;
}

export const policyCli = {
  async run(command: "get" | "set", io: CommandIO, policy?: string): Promise<PolicyResult> {
    const entry = fileURLToPath(new URL("./index.js", import.meta.resolve("@metamask/agent-wallet/plugin")));
    const args = [entry, "wallet", "policy", command, ...(command === "set" ? ["--policy", policy!, "--wait"] : []), "--json"];
    const child = spawn(process.execPath, args, { signal: io.signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", pendingLine = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop()!;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event._notice) io.notify(event._notice);
        } catch {}
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exit = await new Promise<number | null>((resolve, reject) => {
      let error: Error | undefined;
      child.once("error", value => { error = value; });
      child.once("close", code => error ? reject(error) : resolve(code));
    });
    return parseOutput(stdout, stderr, exit);
  },
};

export async function ensureAgreementTrust(subscriber: Address, agreement: Address, io: CommandIO) {
  const matches = (entry: PolicyEntry) => getAddress(entry.address) === getAddress(agreement) && [0, CHAIN_ID].includes(entry.chain_id);
  const read = async () => {
    const result = await policyCli.run("get", io);
    const policy = yaml.load(result.policy ?? "") as Policy;
    if (getAddress(result.address ?? "") !== getAddress(subscriber) || getAddress(policy?.wallet_address ?? "") !== getAddress(subscriber)) {
      throw new Error("Wallet policy belongs to a different subscriber");
    }
    if (!Array.isArray(policy.addresses?.allowlist) || !Array.isArray(policy.addresses?.blocklist)) throw new Error("Wallet policy address lists are missing");
    if (policy.addresses.blocklist.some(matches)) throw new Error("Subscription Agreement is blocked by the wallet policy");
    return policy;
  };
  const policy = await read();
  if (policy.addresses.allowlist.some(matches)) return { alreadyTrusted: true, agreement, chainId: CHAIN_ID };
  policy.addresses.allowlist.push({ address: agreement, chain_id: CHAIN_ID });
  const result = await policyCli.run("set", io, yaml.dump(policy));
  if (result.status !== "confirmed") {
    throw new CommandError("SUBSCRIPTION_TRUST_PENDING", `Agreement trust is ${result.status ?? "unconfirmed"}; request ${result.requestId ?? "unknown"}. Subscription not activated.`,
      "Complete the existing MetaMask approval before retrying subscribe. Do not submit another policy request while it is pending.");
  }
  if (!(await read()).addresses.allowlist.some(matches)) throw new Error("Confirmed wallet policy does not contain Agreement trust; subscription not activated");
  return { alreadyTrusted: false, agreement, chainId: CHAIN_ID };
}
