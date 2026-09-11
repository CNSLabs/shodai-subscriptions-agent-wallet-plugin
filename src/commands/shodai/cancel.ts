import { Args } from "@oclif/core";
import { PluginCommand, type CommandIO } from "@metamask/agent-wallet/plugin";
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbiParameters, toBytes } from "viem";
import { agreementAbi } from "../../abis.js";
import { CHAIN_ID, subscriptionWallet } from "../../wallet.js";

export default class Cancel extends PluginCommand<object> {
  protected readonly pluginCommandId = "shodai:cancel";
  static usage = "mm shodai cancel <agreement-address>";
  static description = "Cancel future subscription renewals; existing paid access remains until expiry";
  static args = { "agreement-address": Args.string({ required: true }) };
  static flags = { ...PluginCommand.baseFlags };
  async execute(io: CommandIO) {
    const agreement = getAddress(String(this.ctx.args?.["agreement-address"]));
    const client = this.ctx.publicClient(CHAIN_ID);
    const canceled = keccak256(toBytes("AUTO_RENEW_OFF"));
    const readState = () => client.readContract({ address: agreement, abi: agreementAbi, functionName: "currentState" });
    if (await readState() === canceled) return { agreement, state: canceled, alreadyCanceled: true };
    const wallet = await subscriptionWallet(this.ctx, io, this.pluginCommandId);
    const payload = encodeAbiParameters(parseAbiParameters("(bytes32 id,uint8 fType,bytes data)[]"), [[]]);
    const inputId = keccak256(toBytes("cancel"));
    const receipt = await wallet.send(agreement, encodeFunctionData({ abi: agreementAbi, functionName: "submitInput", args: [inputId, payload] }), "Cancel future subscription renewals",
      { function: "submitInput(bytes32,bytes)", arguments: { input: "cancel", inputId, fields: [] } });
    const state = await readState();
    if (state !== canceled) throw new Error(`Cancellation transaction ${receipt.hash} did not leave the Agreement canceled`);
    return { agreement, receipt, state, canceled: true };
  }
}
