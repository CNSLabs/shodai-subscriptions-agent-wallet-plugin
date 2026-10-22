import { CommandError } from "@metamask/agent-wallet/plugin";

export async function requestResource(url: string, init: RequestInit, stage: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  try { return await fetchImpl(url, { ...init, redirect: "error" }); }
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

export async function collectionOutcome(response: Response): Promise<{
  outcome: "pending" | "failed" | "unavailable"; subscriptionId?: string; paymentId?: string; message?: string;
} | undefined> {
  if (response.status !== 503) return undefined;
  let body: { code?: string; subscriptionId?: string; paymentId?: string; message?: string };
  try { body = await response.clone().json(); } catch { return undefined; }
  if (body?.code === "subscription_service_unavailable") return { outcome: "unavailable" };
  if (!["subscription_payment_pending", "subscription_payment_failed"].includes(body?.code ?? "") ||
      typeof body.subscriptionId !== "string" || !body.subscriptionId || typeof body.paymentId !== "string" || !body.paymentId) return undefined;
  return { outcome: body.code === "subscription_payment_pending" ? "pending" : "failed", subscriptionId: body.subscriptionId, paymentId: body.paymentId,
    ...(typeof body.message === "string" ? { message: body.message } : {}) };
}
