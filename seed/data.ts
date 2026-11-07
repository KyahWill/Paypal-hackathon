// Everything here is fictional: the barangay, school, org, stores and people.
// Shared by the receipt renderer and the seed, so images and rows always agree.

export const CHARITY = { name: "Samahang Kabataan ng Bagong Tanaw" };

export const PROJECT = {
  slug: "balik-eskwela",
  title: "Balik-Eskwela para sa Bagong Tanaw Elementary School",
  story:
    "Every June, some pupils at Bagong Tanaw Elementary School start the year with one shared notebook between three classmates. Their teachers quietly buy what they can, but it never stretches far enough.\n\nWe are a small youth org from the barangay, and most of us went to this school. Our treasurer buys the supplies first, then every peso is reimbursed from this fund against a real receipt, so you can trust that your gift became a notebook, a box of crayons or a bag for a child who needs one.",
  purpose:
    "School supplies for pupils of Bagong Tanaw Elementary School, a public school in Barangay Bagong Tanaw, San Alipio: notebooks, paper, pencils, pens, crayons, bags and basic classroom materials.",
  startDate: "2026-08-01",
  endDate: "2027-03-31",
  goalMinor: 6_000_000,
};

export const DONATIONS = [
  { donorName: "Maricel D.", amountMinor: 500_000, capturedAt: "2026-08-09T02:14:00Z" },
  { donorName: "Jun-Jun and Family", amountMinor: 250_000, capturedAt: "2026-08-17T11:40:00Z" },
  { donorName: "Anonymous", amountMinor: 100_000, capturedAt: "2026-08-23T06:05:00Z" },
  { donorName: "Batch 2009 Alumni", amountMinor: 1_000_000, capturedAt: "2026-09-02T09:32:00Z" },
  { donorName: "Teacher Liza", amountMinor: 150_000, capturedAt: "2026-09-11T13:21:00Z" },
  { donorName: "Anonymous", amountMinor: 50_000, capturedAt: "2026-09-28T04:47:00Z" },
  { donorName: "Kuya Rommel, Dubai", amountMinor: 300_000, capturedAt: "2026-10-06T15:03:00Z" },
  { donorName: "Ate Joy", amountMinor: 75_000, capturedAt: "2026-10-19T08:18:00Z" },
];

export type ReceiptItem = { description: string; quantity: number; unitPriceMinor: number };

export type ReceiptData = {
  file: string;
  store: string;
  registeredName: string;
  address: string[];
  tin: string;
  min: string;
  serial: string;
  invoiceNo: string;
  // Days above 12 on purpose, so month and day cannot be swapped.
  date: string;
  time: string;
  cashier: string;
  items: ReceiptItem[];
  cashMinor: number;
  style: "plain" | "bold" | "dotted";
};

export const RECEIPTS = {
  // Under the sandbox sender's PHP 5,000 so the real payout can go through.
  clean: {
    file: "clean-valid.png",
    store: "Tala at Lapis School Supplies",
    registeredName: "Tala at Lapis Trading",
    address: ["Stall 14, San Alipio Public Market", "Brgy. Poblacion, San Alipio"],
    tin: "000-482-117-00000",
    min: "26081400912",
    serial: "TL-POS-0172",
    invoiceNo: "00048213",
    date: "2026-10-24",
    time: "10:42",
    cashier: "Rowena",
    items: [
      { description: "Notebook 80 lvs", quantity: 60, unitPriceMinor: 2_850 },
      { description: "Intermediate Pad Paper", quantity: 40, unitPriceMinor: 2_400 },
      { description: "Pencil No.2 Box/12", quantity: 10, unitPriceMinor: 7_200 },
      { description: "Crayons 8 Colors", quantity: 20, unitPriceMinor: 2_625 },
    ],
    cashMinor: 400_000,
    style: "plain",
  },
  // In window, on purpose and not a duplicate: only the balance check should fail.
  overBalance: {
    file: "over-balance.png",
    store: "Bukang-Liwayway Wholesale",
    registeredName: "Bukang-Liwayway Wholesale Corp.",
    address: ["88 Rizal Ave. Extension", "Brgy. Sto. Nino, San Alipio"],
    tin: "000-915-306-00000",
    min: "25110300457",
    serial: "BLW-CTR-03",
    invoiceNo: "0117652",
    date: "2026-10-21",
    time: "14:08",
    cashier: "Mark Anthony",
    items: [
      { description: "Student Backpack", quantity: 100, unitPriceMinor: 18_500 },
      { description: "Art Kit Assorted", quantity: 40, unitPriceMinor: 6_250 },
      { description: "Chalk White Box/100", quantity: 30, unitPriceMinor: 3_875 },
    ],
    cashMinor: 2_250_000,
    style: "bold",
  },
  // The same image is stored on the seeded PAID claim, so it matches by hash
  // as well as by vendor, date and total.
  duplicate: {
    file: "duplicate-of-paid.png",
    store: "Kaibigan Paper & Pen Center",
    registeredName: "Kaibigan Paper and Pen Center",
    address: ["2F Sampaguita Arcade, Quezon St.", "Brgy. Poblacion, San Alipio"],
    tin: "000-263-840-00002",
    min: "24060700388",
    serial: "KPP-01-22",
    invoiceNo: "00205974",
    date: "2026-09-18",
    time: "16:27",
    cashier: "Divina",
    items: [
      { description: "Composition Notebook", quantity: 100, unitPriceMinor: 3_150 },
      { description: "Ballpen Black Box/12", quantity: 5, unitPriceMinor: 9_600 },
      { description: "Manila Paper", quantity: 100, unitPriceMinor: 750 },
      { description: "Bond Paper A4 Ream", quantity: 6, unitPriceMinor: 26_800 },
    ],
    cashMinor: 600_000,
    style: "dotted",
  },
  unreadable: {
    file: "blurry-unreadable.png",
    store: "Aninag Variety Store",
    registeredName: "Aninag Variety Store",
    address: ["Purok 3, Brgy. Bagong Tanaw", "San Alipio"],
    tin: "000-731-552-00000",
    min: "23091200146",
    serial: "AVS-01",
    invoiceNo: "00012076",
    date: "2026-10-16",
    time: "09:15",
    cashier: "Nene",
    items: [
      { description: "Sharpener", quantity: 30, unitPriceMinor: 1_200 },
      { description: "Eraser", quantity: 30, unitPriceMinor: 800 },
      { description: "Ruler 12 in", quantity: 30, unitPriceMinor: 1_500 },
    ],
    cashMinor: 110_000,
    style: "bold",
  },
} satisfies Record<string, ReceiptData>;

export function receiptTotalMinor(receipt: ReceiptData): number {
  return receipt.items.reduce((sum, i) => sum + i.quantity * i.unitPriceMinor, 0);
}

// Philippine VAT is included in the shelf price: 12/112 of the total.
export function receiptVatMinor(receipt: ReceiptData): number {
  return Math.round((receiptTotalMinor(receipt) * 12) / 112);
}
