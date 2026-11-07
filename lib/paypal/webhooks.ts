import { paypalFailure, paypalFetch } from "@/lib/paypal/client";

const SIGNATURE_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

// True only when PayPal itself confirms the event. Throws when it cannot be
// asked, or PAYPAL_WEBHOOK_ID is missing, so the delivery fails and PayPal retries.
export async function verifyWebhookSignature(rawBody: string, headers: Headers): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID is not set");

  const fields: string[] = [];
  for (const [field, header] of Object.entries(SIGNATURE_HEADERS)) {
    const value = headers.get(header);
    if (!value) return false;
    fields.push(`${JSON.stringify(field)}:${JSON.stringify(value)}`);
  }
  fields.push(`"webhook_id":${JSON.stringify(webhookId)}`);

  // The raw bytes go in as they arrived. The signature covers them, so a parsed
  // and re-serialised event could fail verification.
  const response = await paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: `{${fields.join(",")},"webhook_event":${rawBody}}`,
  });
  // PayPal answers 400 to values it cannot use, which is what a forgery looks like.
  if (response.status === 400) return false;
  if (!response.ok) throw await paypalFailure("Verify webhook", response);

  const { verification_status } = (await response.json()) as { verification_status?: string };
  return verification_status === "SUCCESS";
}
