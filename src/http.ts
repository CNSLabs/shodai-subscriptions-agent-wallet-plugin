import { CommandError } from "@metamask/agent-wallet/plugin";

export async function requestResource(url: string, init: RequestInit, stage: string): Promise<Response> {
  try { return await fetch(url, { ...init, redirect: "error" }); }
  catch (error) {
    throw new CommandError("SUBSCRIPTION_CONNECTION_FAILED", `${stage}: ${error instanceof Error ? error.message : String(error)}`,
      "Check that the subscription server is running and the resource URL is current.");
  }
}

export async function resourceError(response: Response, stage: string): Promise<never> {
  throw new CommandError("SUBSCRIPTION_HTTP_ERROR", `${stage}: HTTP ${response.status}: ${await response.text()}`,
    response.status === 402
      ? "Payment or entitlement was not accepted. Check shodai status; HTTP 402 alone does not mean the subscription is canceled."
      : "Inspect the subscription server response before retrying.").withHttpStatus(response.status);
}
