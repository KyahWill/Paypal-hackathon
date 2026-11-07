// Renders seed/receipts/*.png from seed/data.ts using the local Chrome.
// The PNGs are committed, so only re-run this after changing the receipt data.
// Set CHROME_PATH if Chrome is not in the default macOS location.
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import {
  RECEIPTS,
  receiptTotalMinor,
  receiptVatMinor,
  type ReceiptData,
} from "../seed/data";

const CHROME_PATH =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const money = (minor: number) =>
  (minor / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;");

function displayDate(iso: string) {
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

function row(left: string, right: string, className = "") {
  return `<div class="row ${className}"><span>${left}</span><span>${right}</span></div>`;
}

function receiptHtml(r: ReceiptData) {
  const total = receiptTotalMinor(r);
  const vat = receiptVatMinor(r);
  const count = r.items.reduce((sum, i) => sum + i.quantity, 0);
  const items = r.items
    .map(
      (i) => `<div class="item">${i.description}</div>
      ${row(`&nbsp;&nbsp;${i.quantity} x ${money(i.unitPriceMinor)}`, money(i.quantity * i.unitPriceMinor))}`,
    )
    .join("");

  return `
  <div class="receipt ${r.style}">
    <h1>${escapeHtml(r.store)}</h1>
    <div class="center small">
      ${escapeHtml(r.registeredName)}<br />
      ${r.address.join("<br />")}<br />
      VAT REG TIN: ${r.tin}<br />
      MIN: ${r.min} &nbsp; S/N: ${r.serial}
    </div>
    <h2>SALES INVOICE</h2>
    <div class="small">
      ${row(`No. ${r.invoiceNo}`, "CASH SALE")}
      ${row(displayDate(r.date), r.time)}
      ${row(`Cashier: ${r.cashier}`, "POS 01")}
    </div>
    <hr />
    ${items}
    <hr />
    ${row(`${count} item(s)`, "")}
    ${row("TOTAL DUE", `PHP ${money(total)}`, "total")}
    ${row("Cash", money(r.cashMinor))}
    ${row("Change", money(r.cashMinor - total))}
    <hr />
    <div class="small">
      ${row("VATable Sales", money(total - vat))}
      ${row("VAT-Exempt Sales", "0.00")}
      ${row("VAT Zero-Rated Sales", "0.00")}
      ${row("VAT Amount (12%)", money(vat))}
    </div>
    <hr />
    <div class="small">
      Sold to: ______________________<br />
      Address: ______________________<br />
      TIN: __________________________
    </div>
    <div class="center small footer">
      Salamat po! Balik po kayo!<br />
      Items sold are not returnable<br />
      after 7 days with this invoice.
    </div>
  </div>`;
}

const STYLES = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #6f5b49; width: fit-content; }
  .photo {
    padding: 44px 52px;
    background: radial-gradient(circle at 30% 20%, #8d7560, #5b493a 75%);
  }
  .receipt {
    width: 340px;
    padding: 26px 20px 34px;
    background: linear-gradient(178deg, #fdfcf7, #f3f0e6 70%, #ece8db);
    color: #2b2a2e;
    font: 15px/1.38 "Courier New", Courier, monospace;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
  }
  .bold { font-weight: 700; }
  .dotted hr { border-top-style: dotted; }
  h1 { margin: 0 0 6px; font-size: 19px; text-align: center; line-height: 1.2; }
  .dotted h1 { font-family: Georgia, serif; }
  h2 { margin: 12px 0 8px; font-size: 16px; text-align: center; letter-spacing: 3px; }
  hr { border: 0; border-top: 1px dashed #55535a; margin: 9px 0; }
  .center { text-align: center; }
  .small { font-size: 13px; }
  .row { display: flex; justify-content: space-between; gap: 12px; }
  .total { font-size: 17px; font-weight: 700; margin: 4px 0; }
  .footer { margin-top: 16px; }
`;

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 1200, deviceScaleFactor: 2 });

    for (const [key, receipt] of Object.entries(RECEIPTS)) {
      const unreadable = key === "unreadable";
      // Heavy motion-style blur: the ink is still visible but no word survives.
      const paperStyle = unreadable
        ? "filter: blur(7px) contrast(0.85); transform: rotate(-4deg);"
        : `transform: rotate(${key === "clean" ? -0.7 : key === "overBalance" ? 0.9 : -0.4}deg);`;
      await page.setContent(
        `<!doctype html><meta charset="utf-8" /><style>${STYLES}</style>
         <div class="photo" id="shot"><div style="${paperStyle} will-change: transform, filter;">${receiptHtml(receipt)}</div></div>`,
      );
      const shot = await page.$("#shot");
      await shot!.screenshot({ path: join("seed/receipts", receipt.file) as `${string}.png` });
      console.log(`Rendered ${receipt.file}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
