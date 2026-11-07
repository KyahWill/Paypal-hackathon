"use client";

import { useRouter } from "next/navigation";
import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import type { DonationProgress } from "@/lib/donations";
import { formatMoney, fromPayPalValue } from "@/lib/money";
import styles from "./page.module.css";

const PRESETS_MINOR = [10_000, 25_000, 50_000, 100_000];
const DEFAULT_PRESET_MINOR = 50_000;

const PAYPAL_FAILED =
  "We could not finish that with PayPal. Nothing has been recorded yet, so please try again.";
const CONFIRM_FAILED =
  "We could not confirm your gift just now. Please do not pay again yet. If PayPal took your payment, it will appear on this page shortly.";

type PayPalButtons = {
  isEligible: () => boolean;
  render: (container: HTMLElement) => Promise<void>;
  close: () => Promise<void>;
};

type ButtonOptions = {
  style: { layout: "vertical"; shape: "rect"; label: "donate" | "paypal" };
  createOrder: () => Promise<string>;
  onApprove: (
    data: { orderID: string },
    actions: { restart: () => unknown },
  ) => Promise<unknown>;
  onCancel: () => void;
  onError: () => void;
};

declare global {
  interface Window {
    paypal?: { Buttons: (options: ButtonOptions) => PayPalButtons };
  }
}

type Phase =
  | { name: "form" }
  | { name: "confirming" }
  | { name: "thanks"; amountMinor: number }
  | { name: "pending" };

type Props = {
  slug: string;
  currency: string;
  initialProgress: DonationProgress;
  minMinor: number;
  maxMinor: number;
};

function parseCustomAmount(text: string): number | null {
  try {
    return fromPayPalValue(text.trim().replace(/,/g, ""));
  } catch {
    return null;
  }
}

export function DonationPanel({ slug, currency, initialProgress, minMinor, maxMinor }: Props) {
  const router = useRouter();
  const buttonsRef = useRef<HTMLDivElement>(null);

  const [sdkReady, setSdkReady] = useState(false);
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const [message, setMessage] = useState<string | null>(null);
  const [preset, setPreset] = useState<number | null>(DEFAULT_PRESET_MINOR);
  const [customText, setCustomText] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  // Set from the capture response, so the bar moves before the page refreshes.
  const [confirmed, setConfirmed] = useState<DonationProgress | null>(null);

  const progress = confirmed ?? initialProgress;
  const amountMinor = preset ?? parseCustomAmount(customText);
  const amountValid =
    amountMinor !== null && amountMinor >= minMinor && amountMinor <= maxMinor;

  // The buttons live in an iframe and stay mounted, so they read the latest
  // choice from here instead of being rebuilt on every keystroke.
  const choice = useRef({ amountMinor, anonymous });
  useEffect(() => {
    choice.current = { amountMinor, anonymous };
  }, [amountMinor, anonymous]);

  const showForm = phase.name === "form" || phase.name === "confirming";

  useEffect(() => {
    const container = buttonsRef.current;
    if (!sdkReady || !showForm || !container || !window.paypal) return;

    const buttons = window.paypal.Buttons({
      style: { layout: "vertical", shape: "rect", label: "paypal" },

      createOrder: async () => {
        setMessage(null);
        const response = await fetch("/api/donations/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, ...choice.current }),
        });
        const body = (await response.json()) as { orderId?: string; error?: string };
        if (!body.orderId) {
          setMessage(body.error ?? PAYPAL_FAILED);
          throw new Error("Order not created");
        }
        return body.orderId;
      },

      onApprove: async ({ orderID }, actions) => {
        setPhase({ name: "confirming" });
        try {
          const response = await fetch(`/api/donations/orders/${orderID}/capture`, {
            method: "POST",
          });
          const body = (await response.json()) as {
            status: string;
            progress?: DonationProgress;
          };

          if (body.status === "completed" && body.progress) {
            setConfirmed(body.progress);
            setPhase({ name: "thanks", amountMinor: choice.current.amountMinor ?? 0 });
            router.refresh();
          } else if (body.status === "pending") {
            setPhase({ name: "pending" });
          } else if (body.status === "declined") {
            setPhase({ name: "form" });
            setMessage("PayPal could not use that payment method. Please try another one.");
            return actions.restart();
          } else {
            setPhase({ name: "form" });
            setMessage(CONFIRM_FAILED);
          }
        } catch {
          setPhase({ name: "form" });
          setMessage(CONFIRM_FAILED);
        }
      },

      onCancel: () => setMessage("No problem, nothing was charged. You can try again any time."),
      onError: () => setMessage((current) => current ?? PAYPAL_FAILED),
    });

    if (buttons.isEligible()) void buttons.render(container);
    return () => {
      void buttons.close().catch(() => {});
    };
    // The form leaves the page on thanks, so the buttons are rebuilt on the way back.
  }, [sdkReady, slug, router, showForm]);

  function giveAgain() {
    setPhase({ name: "form" });
    setMessage(null);
  }

  return (
    <section className={styles.card} aria-label="Give to this project">
      <Script
        src={`https://www.paypal.com/sdk/js?client-id=${process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID}&currency=${currency}&intent=capture&components=buttons`}
        onReady={() => setSdkReady(true)}
        onError={() => setMessage("PayPal did not load. Please refresh the page and try again.")}
      />

      <p className={styles.raised}>
        <strong>{formatMoney(progress.raisedMinor, currency)}</strong> raised of{" "}
        {formatMoney(progress.goalMinor, currency)}
      </p>
      <div
        className={styles.track}
        role="progressbar"
        aria-label="Progress toward the goal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
      >
        <div className={styles.fill} style={{ width: `${progress.percent}%` }} />
      </div>
      <p className={styles.meta}>
        {progress.percent}% of the goal, from {progress.donorCount}{" "}
        {progress.donorCount === 1 ? "gift" : "gifts"}
      </p>

      {phase.name === "thanks" && (
        <div className={styles.thanks} role="status">
          <h2>Salamat, thank you!</h2>
          <p>
            Your gift of {formatMoney(phase.amountMinor, currency)} is now part of this project.
            The bar above already includes it.
          </p>
          <button type="button" className={styles.again} onClick={giveAgain}>
            Give again
          </button>
        </div>
      )}

      {phase.name === "pending" && (
        <div className={styles.thanks} role="status">
          <h2>Salamat, thank you!</h2>
          <p>
            PayPal is still confirming your payment. Your gift will appear here as soon as it
            clears, so there is no need to pay again.
          </p>
        </div>
      )}

      {showForm && (
        <>
          <fieldset className={styles.amounts} disabled={phase.name === "confirming"}>
            <legend>Choose an amount</legend>
            <div className={styles.presets}>
              {PRESETS_MINOR.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={preset === value}
                  className={styles.preset}
                  onClick={() => setPreset(value)}
                >
                  {formatMoney(value, currency)}
                </button>
              ))}
            </div>
            <label className={styles.custom}>
              <span>Or enter your own ({currency})</span>
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder="750"
                value={customText}
                onFocus={() => setPreset(null)}
                onChange={(event) => {
                  setPreset(null);
                  setCustomText(event.target.value);
                }}
              />
            </label>
            {!amountValid && (customText !== "" || preset !== null) && (
              <p className={styles.hint}>
                Please enter between {formatMoney(minMinor, currency)} and{" "}
                {formatMoney(maxMinor, currency)}.
              </p>
            )}
            <label className={styles.anonymous}>
              <input
                type="checkbox"
                checked={anonymous}
                onChange={(event) => setAnonymous(event.target.checked)}
              />
              <span>Give anonymously</span>
            </label>
            <p className={styles.hint}>
              {anonymous
                ? "We will show \"Anonymous\" in recent gifts."
                : "We will show your first name in recent gifts."}
            </p>
          </fieldset>

          <div
            ref={buttonsRef}
            className={styles.buttons}
            inert={!amountValid || phase.name === "confirming"}
            data-disabled={!amountValid || phase.name === "confirming"}
          />
          {phase.name === "confirming" && (
            <p className={styles.status} role="status">
              Confirming your gift...
            </p>
          )}
          {message && (
            <p className={styles.message} role="alert">
              {message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
