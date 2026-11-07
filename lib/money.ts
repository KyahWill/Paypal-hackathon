// Every amount in the app is integer minor units. These two functions are the
// only crossing point with PayPal's decimal strings, and they stay in strings
// so a float can never round a peso. Two-decimal currencies only, like the seed.
export function toPayPalValue(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error(`Not a minor unit amount: ${amountMinor}`);
  }
  const text = String(amountMinor).padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

export function fromPayPalValue(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error(`Not a PayPal amount: ${value}`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function formatMoney(amountMinor: number, currency: string): string {
  const whole = amountMinor % 100 === 0;
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}
