import { Args, Flags } from "@oclif/core";
import { PluginCommand, type CommandIO } from "@metamask/agent-wallet/plugin";
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbiParameters, toBytes } from "viem";
import { agreementAbi } from "../../abis.js";
import { subscriptionWallet } from "../../wallet.js";

export default class Cancel extends PluginCommand<object> {
  protected readonly pluginCommandId = "shodai:cancel";
  static usage = "mm shodai cancel <agreement-address> --chain-id <id>";
  static summary = "mm shodai cancel <agreement-address> - disable future renewals";
  static description = "Cancel future subscription renewals; existing paid access remains until expiry";
  static args = { "agreement-address": Args.string({ required: true }) };
  static flags = { ...PluginCommand.baseFlags, "chain-id": Flags.integer({ required: true, min: 1 }) };
  async execute(io: CommandIO) {
    const agreement = getAddress(String(this.ctx.args?.["agreement-address"]));
    const chainId = Number(this.ctx.flags?.["chain-id"]);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("A valid --chain-id is required");
    const client = this.ctx.publicClient(chainId);
    if (await client.getChainId() !== chainId) throw new Error("Wallet RPC does not match --chain-id");
    const canceled = keccak256(toBytes("AUTO_RENEW_OFF"));
    const readState = () => client.readContract({ address: agreement, abi: agreementAbi, functionName: "currentState" });
    if (await readState() === canceled) return { agreement, state: canceled, alreadyCanceled: true };
    const wallet = await subscriptionWallet(this.ctx, io, this.pluginCommandId);
    const payload = encodeAbiParameters(parseAbiParameters("(bytes32 id,uint8 fType,bytes data)[]"), [[]]);
    const inputId = keccak256(toBytes("cancel"));
    const receipt = await wallet.send(chainId, agreement, encodeFunctionData({ abi: agreementAbi, functionName: "submitInput", args: [inputId, payload] }), "Cancel future subscription renewals",
      { function: "submitInput(bytes32,bytes)", arguments: { input: "cancel", inputId, fields: [] } });
    const state = await readState();
    if (state !== canceled) throw new Error(`Cancellation transaction ${receipt.hash} did not leave the Agreement canceled`);
    return { agreement, receipt, state, canceled: true };
  }
}
