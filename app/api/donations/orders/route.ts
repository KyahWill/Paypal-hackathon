import { z } from "zod";
import { prisma } from "@/lib/db";
import { encodeCustomId, MAX_DONATION_MINOR, MIN_DONATION_MINOR } from "@/lib/donations";
import { toPayPalValue } from "@/lib/money";
import { createOrder } from "@/lib/paypal/checkout";
import { describeError } from "@/lib/paypal/client";

const requestSchema = z.object({
  slug: z.string().min(1).max(100),
  amountMinor: z.number().int().min(MIN_DONATION_MINOR).max(MAX_DONATION_MINOR),
  anonymous: z.boolean(),
});

// Writes nothing to our database. A Donation exists only once a capture completes.
export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Please check the amount and try again." }, { status: 400 });
  }
  const { slug, amountMinor, anonymous } = parsed.data;

  try {
    const project = await prisma.project.findUnique({ where: { slug } });
    if (!project) {
      return Response.json({ error: "We could not find this project." }, { status: 404 });
    }
    if (project.currency !== process.env.CURRENCY) {
      throw new Error(`Project is in ${project.currency}, app is in ${process.env.CURRENCY}`);
    }

    const order = await createOrder({
      value: toPayPalValue(amountMinor),
      currency: project.currency,
      description: `Donation: ${project.title}`,
      customId: encodeCustomId(project.id, anonymous),
    });
    // The id is the only trace of an order that is approved but never captured.
    console.info(`Created order ${order.id}: ${project.slug} ${order.status}`);
    return Response.json({ orderId: order.id });
  } catch (error) {
    console.error("Create order failed:", describeError(error));
    return Response.json(
      { error: "We could not reach PayPal just now. Please try again in a moment." },
      { status: 502 },
    );
  }
}
