import { Args } from "@oclif/core";
import { CommandError, PluginCommand, type CommandIO } from "@metamask/agent-wallet/plugin";
import { type SubscriptionStatus } from "../../protocol.js";
import { selectOffer } from "../../offer.js";
import { requestResource, resourceError } from "../../http.js";
import { resourceUrl, selectedAddress } from "../../wallet.js";
import { requestInit } from "../../request.js";

export default class Status extends PluginCommand<SubscriptionStatus> {
  protected readonly pluginCommandId = "shodai:status";
  static usage = "mm shodai status <resource-url>";
  static summary = "mm shodai status <resource-url> - read subscription and renewal status";
  static description = "Read renewal, paid access, and latest merchant collection status without signing or paying";
  static args = { "resource-url": Args.string({ required: true }) };
  static flags = { ...PluginCommand.baseFlags };

  async execute(_io: CommandIO): Promise<SubscriptionStatus> {
    const url = resourceUrl(this.ctx.args?.["resource-url"]);
    const response = await requestResource(url, requestInit({ method: "GET" }), "Status discovery");
    const header = response.headers.get("payment-required");
    if (response.status !== 402 || !header) return resourceError(response, "Status discovery");
    const endpoint = selectOffer(header, url).statusUrl;
    if (!endpoint) throw new CommandError("SUBSCRIPTION_STATUS_UNAVAILABLE", "Resource does not advertise public subscription status", "Check the resource URL and server version.");
    const statusUrl = new URL(endpoint);
    statusUrl.searchParams.set("subscriber", selectedAddress(this.ctx));
    const status = await requestResource(statusUrl.href, {}, "Subscription status");
    if (!status.ok) return resourceError(status, "Subscription status");
    return await status.json() as SubscriptionStatus;
  }
}
