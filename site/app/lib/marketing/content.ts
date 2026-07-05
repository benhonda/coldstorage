/*
 * Marketing site content — typed, ported VERBATIM from the upstream design
 * (`design-mirror/marketing/shared/site-common.jsx`, voiced per `uploads/BRAND-VOICE.md`).
 * The copy is authoritative — do not paraphrase or "improve" it here; edit it upstream and
 * re-pull. English-only today; the `/fr` pass will pair each string with its translation
 * (see site/SPEC.md → i18n). Only the pieces the shipped Master composes are ported.
 */

/* ─────────────────────────────  How it works  ───────────────────────────── */

export type HowStep = {
  /** two-digit step number, e.g. "01" */
  n: string;
  /** Material Symbols Rounded glyph name */
  icon: string;
  title: string;
  body: string;
};

/** Four honest steps (step four is the deliberately-frank one). */
export const HOW_STEPS: HowStep[] = [
  {
    n: "01",
    icon: "ads_click",
    title: "Point it at what matters",
    body: "Pick your Photos library and the folders you'd hate to lose — or drag them in. It works like copying to a drive: no per-upload meter, no decisions.",
  },
  {
    n: "02",
    icon: "lock",
    title: "It scrambles and ships",
    body: "Everything is encrypted on your Mac before it leaves, then archived to deep storage somewhere else entirely. Newest photos go first, so the things you'd miss most are safe soonest.",
  },
  {
    n: "03",
    icon: "photo_library",
    title: "Browse everything, always",
    body: "Your whole archive stays browsable — file tree and thumbnails, instantly, without touching cold storage. Proof of safety you can look at.",
  },
  {
    n: "04",
    icon: "cloud_download",
    title: "Getting it back is a quote, then a wait",
    body: "A restore isn't instant — it's a recovery. Pick what you need, see the exact cost and ready-time, and nothing starts until you say go. Most people restore a folder, not the library.",
  },
];

/* ───────────────────────────────  Privacy  ──────────────────────────────── */

export type PrivacyRow = { label: string; value: string; icon: string };

/** Commitments, in writing (V1-honest — claims match the architecture). */
export const PRIVACY_ROWS: PrivacyRow[] = [
  { label: "Scanning your files", value: "Never", icon: "visibility_off" },
  { label: "AI training on your data", value: "Never", icon: "smart_toy" },
  { label: "Ads, or selling data", value: "Never", icon: "block" },
  { label: "Human access", value: "Audit-logged, with your say-so", icon: "shield_person" },
  { label: "Leaving", value: "Export everything, anytime", icon: "output" },
];

export const KEY_ESCROW_LINE =
  "One more honest detail: today we hold your key — as escrow, so recovery works when you need it. " +
  "It's audit-logged, only ever used with your say-so, and we're moving it onto your device alone.";

/* ───────────────────────────────  Pricing  ──────────────────────────────── */

export type Term = { id: string; label: string };

/** The settled 3×4 matrix (SPEC §5). A term is exactly N × the yearly rate;
    the only discount in the model is the gentle size-taper. */
export const TERMS: Term[] = [
  { id: "1yr", label: "1 year" },
  { id: "2yr", label: "2 years" },
  { id: "3yr", label: "3 years" },
  { id: "5yr", label: "5 years" },
];

type MatrixEntry = { perYear: string; perMonth: string; totals: Record<string, string> };

const MATRIX: Record<string, MatrixEntry> = {
  "500 GB": { perYear: "$9.99", perMonth: "$0.83", totals: { "1yr": "$9.99", "2yr": "$19.98", "3yr": "$29.97", "5yr": "$49.95" } },
  "1 TB": { perYear: "$18.99", perMonth: "$1.58", totals: { "1yr": "$18.99", "2yr": "$37.98", "3yr": "$56.97", "5yr": "$94.95" } },
  "2 TB": { perYear: "$36.99", perMonth: "$3.08", totals: { "1yr": "$36.99", "2yr": "$73.98", "3yr": "$110.97", "5yr": "$184.95" } },
};

const TERM_WORDS: Record<string, string> = {
  "1yr": "for one year",
  "2yr": "for two years",
  "3yr": "for three years",
  "5yr": "for five years",
};

export type PriceCell = { price: string; period: string; perYear: string; perMonth: string };
export type PricingTier = {
  name: string;
  size: string;
  featured: boolean;
  ctaLabel: string;
  prices: Record<string, PriceCell>;
};

/** Derive the tier list (name × term → price cell) from the matrix. */
export function pricingTiers(ctaLabel = "Get started"): PricingTier[] {
  return Object.entries(MATRIX).map(([name, t], i) => ({
    name,
    size: name,
    featured: i === 1,
    ctaLabel,
    prices: Object.fromEntries(
      TERMS.map(({ id }) => [
        id,
        { price: t.totals[id], period: TERM_WORDS[id], perYear: t.perYear, perMonth: t.perMonth },
      ])
    ),
  }));
}

export const ENTERPRISE = {
  title: "Keeping more than 2 TB?",
  note: "Same rate, same gentle taper — tell us what you keep and we'll set it up.",
  cta: "Tell us",
};

export const RATE_LOCK =
  "A longer term isn't a discount — it's a rate lock. Every term is exactly that many years at today's rate, " +
  "and if our costs rise mid-term, we absorb the difference until your term ends.";

export const TAPER_NOTE =
  "Bigger tiers cost slightly less per GB because one account is cheaper for us to run than two — " +
  "we pass that back. It's the only discount in the model.";

export const TIERS_NOTE = "Every tier is the whole product. The only difference is room.";

/* ─────────────────────────────────  FAQ  ────────────────────────────────── */

export type FaqItem = { question: string; answer: string };

/** Full FAQ, in the Master's order: where · sync · cost · lapse · floor · wind-down. */
export const FAQ: FaqItem[] = [
  {
    question: "Where is my data stored?",
    answer:
      "In Amazon's S3 Glacier Deep Archive — the industrial vault big companies use for the things they keep for decades. We're the simple, private layer on top: your files are scrambled on your Mac before they leave it, so what sits in that vault is data nobody can read.",
  },
  {
    question: "Is this like iCloud or Dropbox?",
    answer:
      "No — those sync your working files and read them along the way. ColdStorage works like a drive you keep somewhere else: what you put is what's there, with no versioning. Putting things in feels like copying to an SSD. Getting things out is a recovery — a short wait and a quoted fee, shown before you commit.",
  },
  {
    question: "Why does getting files back cost money?",
    answer:
      "Because pulling data out of deep storage has a real cost, and we pass it through at the raw rate we're charged — no markup. Most recoveries are small: a folder runs about fifty cents. Pulling back a full 500 GB archive at once is about $46. Either way you see the exact number first, and nothing's charged until you say go.",
  },
  {
    question: "What happens if I stop paying?",
    answer:
      "Nothing dramatic. Your archive goes read-only — untouched and browsable, with nothing new going in. You get about six months of grace and clear reminders, then a final warning long before anything is touched. We never delete over a lapsed card.",
  },
  {
    question: "What's the 180-day minimum?",
    answer:
      "Deep storage bills a 180-day minimum per file, so something you delete on day 10 still bills out the rest of that window. Delete freely — it's your drive — we just want you to know how the meter runs before it matters.",
  },
  {
    question: "What if ColdStorage shuts down?",
    answer:
      "If we ever wind down, you get at least six months' notice to take your archive elsewhere before anything is deleted. It's a commitment we publish and stand behind: your archive shouldn't vanish because our company did.",
  },
];

/* ─────────────────────────────────  Footer  ─────────────────────────────── */

export type FooterLink = { label: string; href?: string };
export type FooterColumn = { heading: string; links: FooterLink[] };
export type Footer = {
  tagline: string;
  columns: FooterColumn[];
  legal: FooterLink[];
  copyright: string;
};

export const FOOTER: Footer = {
  tagline: "The offsite copy your drawer-SSD can't be.",
  columns: [
    { heading: "Product", links: [{ label: "How it works", href: "#how" }, { label: "Pricing", href: "#pricing" }, { label: "Privacy", href: "#privacy" }] },
    { heading: "Company", links: [{ label: "About" }, { label: "The wind-down promise" }, { label: "Transparency notes" }] },
    { heading: "Support", links: [{ label: "Help center" }, { label: "Status" }, { label: "Contact us" }] },
  ],
  legal: [{ label: "Privacy" }, { label: "Terms" }],
  copyright: "© 2026 ColdStorage",
};
