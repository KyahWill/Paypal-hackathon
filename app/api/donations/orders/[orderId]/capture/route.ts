import { getProjectProgress, recordCompletedDonation } from "@/lib/donations";
import { captureOrder } from "@/lib/paypal/checkout";
import { describeError, PayPalError } from "@/lib/paypal/client";

const ORDER_ID = /^[A-Z0-9]{10,40}$/;

export async function POST(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (!ORDER_ID.test(orderId)) {
    return Response.json({ status: "failed" }, { status: 400 });
  }

  try {
    const result = await recordCompletedDonation(await captureOrder(orderId));

    if (result.outcome === "recorded" || result.outcome === "already-recorded") {
      return Response.json({
        status: "completed",
        progress: await getProjectProgress(result.projectId),
      });
    }

    // Not a Donation yet. A pending capture arrives through the webhook, and
    // an ignored one has taken money we did not count, so it has to be seen.
    if (result.outcome === "ignored") {
      console.error(`Captured order ${orderId} not recorded: ${result.reason}`);
    }
    return Response.json({ status: "pending" }, { status: 202 });
  } catch (error) {
    // The JS SDK can reopen PayPal so the donor picks another way to pay.
    if (error instanceof PayPalError && error.issue === "INSTRUMENT_DECLINED") {
      return Response.json({ status: "declined" }, { status: 422 });
    }
    console.error(`Capture of ${orderId} failed:`, describeError(error));
    return Response.json({ status: "failed" }, { status: 502 });
  }
}
