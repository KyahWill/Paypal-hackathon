// Hardcoded on purpose, like the scripts: the app must never reach live PayPal.
const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
// Refresh a little early, so a token cannot expire in the middle of a request.
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

let cachedToken: { value: string; expiresAt: number } | null = null;

// Carries PayPal's error name and first issue only. Bodies can hold payer
// details, and they must stay out of logs (rule 5).
export class PayPalError extends Error {
  constructor(
    step: string,
    readonly status: number,
    readonly errorName?: string,
    readonly issue?: string,
  ) {
    super(`${step} failed: ${status} ${errorName ?? "unknown"} ${issue ?? ""}`.trim());
    this.name = "PayPalError";
  }
}

// For logs. Only our own PayPalError message is known to be free of secrets, so
// anything else is reduced to its name, as in the health route.
export function describeError(error: unknown): string {
  if (error instanceof PayPalError) return error.message;
  return error instanceof Error ? error.name : "unknown";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const credentials = `${requireEnv("PAYPAL_CLIENT_ID")}:${requireEnv("PAYPAL_CLIENT_SECRET")}`;
  const response = await fetch(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new PayPalError("PayPal OAuth", response.status);

  const { access_token, expires_in } = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    value: access_token,
    expiresAt: Date.now() + expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
  };
  return access_token;
}

export async function paypalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${PAYPAL_SANDBOX_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

export async function paypalFailure(step: string, response: Response): Promise<PayPalError> {
  const body = (await response.json().catch(() => ({}))) as {
    name?: string;
    details?: { issue?: string }[];
  };
  return new PayPalError(step, response.status, body.name, body.details?.[0]?.issue);
}
