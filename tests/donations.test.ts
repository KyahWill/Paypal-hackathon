import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DonationStatus } from "@/app/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { truncateAllTables } from "@/lib/db-reset";
import {
  encodeCustomId,
  getProjectProgress,
  parseCustomId,
  recordCompletedDonation,
} from "@/lib/donations";
import type { CheckoutOrder } from "@/lib/paypal/checkout";

let projectId: string;

function order(overrides: {
  id?: string;
  captureId?: string;
  status?: string;
  value?: string;
  currency?: string;
  customId?: string;
  givenName?: string;
} = {}): CheckoutOrder {
  return {
    id: overrides.id ?? "ORDER1",
    status: "COMPLETED",
    payer: { name: { given_name: overrides.givenName ?? "Maria" } },
    purchase_units: [
      {
        custom_id: overrides.customId ?? encodeCustomId(projectId, false),
        payments: {
          captures: [
            {
              id: overrides.captureId ?? "CAPTURE1",
              status: overrides.status ?? "COMPLETED",
              amount: {
                currency_code: overrides.currency ?? "PHP",
                value: overrides.value ?? "500.00",
              },
              create_time: "2026-11-07T06:00:00Z",
            },
          ],
        },
      },
    ],
  };
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  const charity = await prisma.charity.create({
    data: { name: "Test Charity", payoutEmail: "charity@example.test" },
  });
  const project = await prisma.project.create({
    data: {
      charityId: charity.id,
      slug: randomUUID(),
      title: "Test Project",
      story: "Testing",
      purpose: "Testing",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      goalMinor: 1_000_000,
      currency: "PHP",
    },
  });
  projectId = project.id;
});

afterAll(() => prisma.$disconnect());

describe("custom id", () => {
  it("round trips the project and the anonymous choice", () => {
    expect(parseCustomId(encodeCustomId("abc123", true))).toEqual({
      projectId: "abc123",
      anonymous: true,
    });
    expect(parseCustomId(encodeCustomId("abc123", false))?.anonymous).toBe(false);
  });

  it.each([undefined, "", "abc123", "abc123|maybe", "ABC|anon", "a|anon|b"])(
    "does not recognise %j",
    (customId) => {
      expect(parseCustomId(customId)).toBeNull();
    },
  );
});

describe("recordCompletedDonation", () => {
  it("records a completed capture as CAPTURED, in minor units", async () => {
    expect(await recordCompletedDonation(order({ value: "19.99" }))).toEqual({
      outcome: "recorded",
      projectId,
    });
    expect(await prisma.donation.findUniqueOrThrow({ where: { paypalOrderId: "ORDER1" } }))
      .toMatchObject({
        paypalCaptureId: "CAPTURE1",
        amountMinor: 1_999,
        currency: "PHP",
        status: DonationStatus.CAPTURED,
        donorName: "Maria",
        capturedAt: new Date("2026-11-07T06:00:00Z"),
      });
  });

  it("is idempotent on the order id, and leaves the first row alone", async () => {
    await recordCompletedDonation(order());
    expect(await recordCompletedDonation(order({ givenName: "Changed" }))).toMatchObject({
      outcome: "already-recorded",
    });
    expect(await prisma.donation.findMany()).toMatchObject([{ donorName: "Maria" }]);
  });

  it("records once when the capture route and the webhook race", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recordCompletedDonation(order())),
    );
    expect(results.filter((r) => r.outcome === "recorded")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already-recorded")).toHaveLength(7);
    expect(await prisma.donation.count()).toBe(1);
  });

  it("does not bring a refunded donation back", async () => {
    await recordCompletedDonation(order());
    await prisma.donation.update({
      where: { paypalOrderId: "ORDER1" },
      data: { status: DonationStatus.REFUNDED },
    });
    await recordCompletedDonation(order());
    expect((await prisma.donation.findFirstOrThrow()).status).toBe(DonationStatus.REFUNDED);
  });

  it.each(["PENDING", "DECLINED", "FAILED"])("records nothing for a %s capture", async (status) => {
    expect(await recordCompletedDonation(order({ status }))).toEqual({
      outcome: "not-completed",
      status,
    });
    expect(await prisma.donation.count()).toBe(0);
  });

  it("records nothing for an order with no capture", async () => {
    const approved = { id: "ORDER1", status: "APPROVED", purchase_units: [{}] };
    expect(await recordCompletedDonation(approved)).toEqual({
      outcome: "not-completed",
      status: "APPROVED",
    });
    expect(await prisma.donation.count()).toBe(0);
  });

  it("reads the custom id from the capture when the unit does not repeat it", async () => {
    const base = order();
    const capture = base.purchase_units![0].payments!.captures![0];
    const reshaped: CheckoutOrder = {
      ...base,
      purchase_units: [
        { payments: { captures: [{ ...capture, custom_id: encodeCustomId(projectId, false) }] } },
      ],
    };
    expect(await recordCompletedDonation(reshaped)).toMatchObject({ outcome: "recorded" });
  });

  it("stores no name for an anonymous donor", async () => {
    await recordCompletedDonation(order({ customId: encodeCustomId(projectId, true) }));
    expect((await prisma.donation.findFirstOrThrow()).donorName).toBeNull();
  });

  it("stores no name when PayPal gives none", async () => {
    await recordCompletedDonation({ ...order(), payer: undefined });
    expect((await prisma.donation.findFirstOrThrow()).donorName).toBeNull();
  });

  it.each([
    ["no custom id", () => order({ customId: "" })],
    ["an unknown project", () => order({ customId: encodeCustomId("nosuchproject", false) })],
    ["a different currency", () => order({ currency: "USD" })],
  ])("ignores an order with %s", async (_, build) => {
    expect((await recordCompletedDonation(build())).outcome).toBe("ignored");
    expect(await prisma.donation.count()).toBe(0);
  });

  it("refuses a malformed amount rather than guessing", async () => {
    await expect(recordCompletedDonation(order({ value: "5,000.00" }))).rejects.toThrow();
    expect(await prisma.donation.count()).toBe(0);
  });
});

describe("getProjectProgress", () => {
  it("counts captured donations only, and lists the newest first", async () => {
    await recordCompletedDonation(order());
    await recordCompletedDonation(
      order({ id: "ORDER2", captureId: "CAPTURE2", customId: encodeCustomId(projectId, true) }),
    );
    await prisma.donation.create({
      data: {
        projectId,
        paypalOrderId: "ORDER3",
        amountMinor: 900_000,
        currency: "PHP",
        status: DonationStatus.REFUNDED,
        capturedAt: new Date("2026-12-01T00:00:00Z"),
      },
    });
    await prisma.donation.update({
      where: { paypalOrderId: "ORDER2" },
      data: { capturedAt: new Date("2026-11-08T00:00:00Z") },
    });

    expect(await getProjectProgress(projectId)).toMatchObject({
      currency: "PHP",
      raisedMinor: 100_000,
      goalMinor: 1_000_000,
      percent: 10,
      donorCount: 2,
      recent: [
        { name: "Anonymous", amountMinor: 50_000 },
        { name: "Maria", amountMinor: 50_000 },
      ],
    });
  });

  it("caps the percentage once the goal is passed", async () => {
    await recordCompletedDonation(order({ value: "20000.00" }));
    expect(await getProjectProgress(projectId)).toMatchObject({
      raisedMinor: 2_000_000,
      percent: 100,
    });
  });
});
