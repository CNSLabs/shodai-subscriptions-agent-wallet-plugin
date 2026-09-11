import { Args } from "@oclif/core";
import { CommandError, PluginCommand, type CommandIO } from "@metamask/agent-wallet/plugin";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { SUBSCRIPTION_SCHEME, type SubscriptionStatus } from "../../protocol.js";
import { requestResource, resourceError } from "../../http.js";
import { resourceUrl, selectedAddress } from "../../wallet.js";

export default class Status extends PluginCommand<SubscriptionStatus> {
  protected readonly pluginCommandId = "shodai:status";
  static usage = "mm shodai status <resource-url>";
  static description = "Read renewal, paid access, and latest merchant collection status without signing or paying";
  static args = { "resource-url": Args.string({ required: true }) };
  static flags = { ...PluginCommand.baseFlags };

  async execute(_io: CommandIO): Promise<SubscriptionStatus> {
    const url = resourceUrl(this.ctx.args?.["resource-url"]);
    const response = await requestResource(url, {}, "Status discovery");
    const header = response.headers.get("payment-required");
    if (response.status !== 402 || !header) return resourceError(response, "Status discovery");
    const required = decodePaymentRequiredHeader(header);
    const endpoint = required.accepts.find(r => r.scheme === SUBSCRIPTION_SCHEME)?.extra.statusEndpoint;
    if (typeof endpoint !== "string") throw new CommandError("SUBSCRIPTION_STATUS_UNAVAILABLE", "Resource does not advertise public subscription status", "Check the resource URL and server version.");
    const statusUrl = new URL(resourceUrl(endpoint));
    if (statusUrl.origin !== new URL(url).origin) throw new CommandError("SUBSCRIPTION_STATUS_UNAVAILABLE", "Status endpoint must belong to the resource origin", "Check the advertised status endpoint.");
    statusUrl.searchParams.set("subscriber", selectedAddress(this.ctx));
    const status = await requestResource(statusUrl.href, {}, "Subscription status");
    if (!status.ok) return resourceError(status, "Subscription status");
    return await status.json() as SubscriptionStatus;
  }
}
