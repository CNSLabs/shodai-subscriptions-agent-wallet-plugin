import { Args } from "@oclif/core";
import { PluginCommand, type CommandIO } from "@metamask/agent-wallet/plugin";
import { accessResource } from "../../access.js";
import { resourceUrl, subscriptionWallet } from "../../wallet.js";

export default class Access extends PluginCommand<{ status: number; content: string }> {
  protected readonly pluginCommandId = "shodai:access";
  static usage = "mm shodai access <resource-url>";
  static summary = "mm shodai access <resource-url> - authenticate and retrieve protected content";
  static description = "Read an existing Shodai subscription resource using Agent Wallet authentication";
  static args = { "resource-url": Args.string({ required: true }) };
  static flags = { ...PluginCommand.baseFlags };
  async execute(io: CommandIO) {
    const url = resourceUrl(this.ctx.args?.["resource-url"]);
    return accessResource(url, await subscriptionWallet(this.ctx, io, this.pluginCommandId));
  }
}
