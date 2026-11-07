import { recordCompletedDonation } from "@/lib/donations";
import { getOrder } from "@/lib/paypal/checkout";
import { describeError } from "@/lib/paypal/client";
import { verifyWebhookSignature } from "@/lib/paypal/webhooks";

type WebhookEvent = {
  id?: string;
  event_type?: string;
  resource?: { supplementary_data?: { related_ids?: { order_id?: string } } };
};

// The backup path, for a donor who closes the tab before the capture response
// returns. A 2xx tells PayPal to stop. Anything else makes it deliver again later.
export async function POST(request: Request) {
  const rawBody = await request.text();

  let event: WebhookEvent;
  try {
    event = JSON.parse(rawBody) as WebhookEvent;
  } catch {
    return new Response(null, { status: 400 });
  }

  try {
    if (!(await verifyWebhookSignature(rawBody, request.headers))) {
      console.warn("PayPal webhook refused: signature did not verify");
      return new Response(null, { status: 400 });
    }
    if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
      return new Response(null, { status: 200 });
    }

    const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
    if (!orderId) {
      console.error(`PayPal webhook ${event.id} has no order id`);
      return new Response(null, { status: 200 });
    }

    // The event has no payer name, so PayPal's order is what gets recorded. This
    // also means both paths record exactly the same thing.
    const order = await getOrder(orderId);
    if (!order) {
      console.warn(`PayPal webhook ${event.id}: order ${orderId} not found`);
      return new Response(null, { status: 200 });
    }

    const result = await recordCompletedDonation(order);
    console.info(`PayPal webhook ${event.id}: order ${orderId} ${result.outcome}`);
    // The event says COMPLETED, so a different answer from the order may be lag.
    if (result.outcome === "not-completed") return new Response(null, { status: 503 });
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error(`PayPal webhook ${event.id} failed:`, describeError(error));
    return new Response(null, { status: 500 });
  }
}
