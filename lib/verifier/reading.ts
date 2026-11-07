import { z } from "zod";

// What the model is asked for. It copies amounts as printed, in major units,
// and readReceipt converts them, so the model never does arithmetic on money.
export const ReceiptReadingSchema = z.object({
  unreadable: z.boolean().describe("True if the text cannot be read reliably"),
  vendor: z.string().nullable(),
  date: z.string().nullable().describe("Purchase date as YYYY-MM-DD"),
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number(),
      lineTotal: z.number(),
    }),
  ),
  total: z.number().nullable().describe("Final amount due as printed"),
  currency: z.string().nullable().describe("ISO 4217 code"),
  confidence: z.number().describe("From 0 to 1: how sure you are every field is correct"),
});

export type RawReceiptReading = z.infer<typeof ReceiptReadingSchema>;

export type ExtractedReceipt = {
  vendor: string;
  date: string;
  lineItems: {
    description: string;
    quantity: number;
    unitPriceMinor: number;
    totalMinor: number;
  }[];
  totalMinor: number;
  currency: string;
  confidence: number;
};

export type ReceiptReading =
  | { outcome: "read"; receipt: ExtractedReceipt }
  | { outcome: "unreadable" }
  | { outcome: "failed"; reason: string };

const toMinor = (major: number) => Math.round(major * 100);

function isRealDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}

// The schema only proves the shape. This proves the values can be trusted to
// reach the deterministic checks.
export function normaliseReading(raw: RawReceiptReading): ReceiptReading {
  if (raw.unreadable) return { outcome: "unreadable" };

  const { vendor, date, total, currency, confidence, lineItems } = raw;
  if (!vendor?.trim() || !date || total === null || !currency) {
    return { outcome: "failed", reason: "Missing vendor, date, total or currency" };
  }
  if (!isRealDate(date)) return { outcome: "failed", reason: "Date is not a real YYYY-MM-DD date" };
  if (!(total > 0) || !Number.isFinite(total)) {
    return { outcome: "failed", reason: "Total is not a positive amount" };
  }
  if (!(confidence >= 0 && confidence <= 1)) {
    return { outcome: "failed", reason: "Confidence is outside 0 to 1" };
  }
  if (lineItems.length === 0) return { outcome: "failed", reason: "No line items" };

  return {
    outcome: "read",
    receipt: {
      vendor: vendor.trim(),
      date,
      lineItems: lineItems.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPriceMinor: toMinor(item.unitPrice),
        totalMinor: toMinor(item.lineTotal),
      })),
      totalMinor: toMinor(total),
      currency: currency.toUpperCase(),
      confidence,
    },
  };
}
