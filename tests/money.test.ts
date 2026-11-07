import { describe, expect, it } from "vitest";
import { formatMoney, fromPayPalValue, toPayPalValue } from "@/lib/money";

describe("toPayPalValue", () => {
  it.each([
    [5, "0.05"],
    [50, "0.50"],
    [5_000, "50.00"],
    [123_456, "1234.56"],
  ])("writes %i as %s", (minor, value) => {
    expect(toPayPalValue(minor)).toBe(value);
  });

  it.each([1.5, -1, Number.NaN])("refuses %d", (minor) => {
    expect(() => toPayPalValue(minor)).toThrow();
  });
});

describe("fromPayPalValue", () => {
  it.each([
    ["1000", 100_000],
    ["1000.5", 100_050],
    ["1000.50", 100_050],
    // 19.99 * 100 is 1998.9999999999998 as a float.
    ["19.99", 1_999],
    ["0.07", 7],
  ])("reads %s as %i", (value, minor) => {
    expect(fromPayPalValue(value)).toBe(minor);
  });

  it.each(["", "abc", "1.234", "-5.00", "1,000.00", "1e3"])("refuses %j", (value) => {
    expect(() => fromPayPalValue(value)).toThrow();
  });
});

describe("formatMoney", () => {
  it("hides centavos on whole amounts and keeps them otherwise", () => {
    expect(formatMoney(2_425_000, "PHP")).toBe("₱24,250");
    expect(formatMoney(1_999, "PHP")).toBe("₱19.99");
  });
});
