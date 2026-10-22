import { Args, Flags } from "@oclif/core";
import { PluginCommand, type CommandIO } from "@metamask/agent-wallet/plugin";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { accessResource } from "../../access.js";
import { resourceUrl, subscriptionWallet } from "../../wallet.js";
import { resourceRequest } from "../../request.js";

export default class Access extends PluginCommand<{ status: number; content: string }> {
  protected readonly pluginCommandId = "shodai:access";
  static usage = "mm shodai access <resource-url>";
  static summary = "mm shodai access <resource-url> - authenticate and retrieve protected content";
  static description = "Access an existing subscription resource using Agent Wallet authentication";
  static args = { "resource-url": Args.string({ required: true }) };
  static flags = { ...PluginCommand.baseFlags, method: Flags.string({ default: "GET" }), body: Flags.string() };
  async execute(io: CommandIO) {
    const url = resourceUrl(this.ctx.args?.["resource-url"]);
    return accessResource(url, await subscriptionWallet(this.ctx, io, this.pluginCommandId), resourceRequest(this.ctx.flags ?? {}), async chainId => {
      const client = this.ctx.publicClient(chainId);
      getSmartAccountsEnvironment(chainId);
      if (await client.getChainId() !== chainId) throw new Error(`Unsupported subscription chain ${chainId}`);
    });
  }
}
