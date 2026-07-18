/* ColdStorage marketing concepts — shared data, copy, and site helpers.
   All copy follows uploads/BRAND-VOICE.md (calm · plain · quietly warm · straight). */

/* ── Pricing — the settled 3×4 matrix (SPEC §5). A term is exactly N × the
      yearly rate; the only discount in the model is the gentle size-taper. ── */

const CS_TERMS = [
  { id: "1yr", label: "1 year" },
  { id: "2yr", label: "2 years" },
  { id: "3yr", label: "3 years" },
  { id: "5yr", label: "5 years" },
];

const CS_MATRIX = {
  "500 GB": { perYear: "$9.99",  perMonth: "$0.83", totals: { "1yr": "$9.99",  "2yr": "$19.98", "3yr": "$29.97",  "5yr": "$49.95" } },
  "1 TB":   { perYear: "$18.99", perMonth: "$1.58", totals: { "1yr": "$18.99", "2yr": "$37.98", "3yr": "$56.97",  "5yr": "$94.95" } },
  "2 TB":   { perYear: "$36.99", perMonth: "$3.08", totals: { "1yr": "$36.99", "2yr": "$73.98", "3yr": "$110.97", "5yr": "$184.95" } },
};

const CS_TERM_WORDS = { "1yr": "for one year", "2yr": "for two years", "3yr": "for three years", "5yr": "for five years" };

function csPricingTiers(ctaLabel) {
  return Object.entries(CS_MATRIX).map(([name, t], i) => ({
    name,
    size: name,
    featured: i === 1,
    ctaLabel: ctaLabel || "Get started",
    prices: Object.fromEntries(CS_TERMS.map(({ id }) => [id, {
      price: t.totals[id],
      period: CS_TERM_WORDS[id],
      perYear: t.perYear,
      perMonth: t.perMonth,
    }])),
  }));
}

const CS_ENTERPRISE = {
  title: "Keeping more than 2 TB?",
  note: "Same rate, same gentle taper — tell us what you keep and we'll set it up.",
  cta: "Tell us",
};

const CS_RATE_LOCK =
  "A longer term isn't a discount — it's a rate lock. Every term is exactly that many years at today's rate, " +
  "and if our costs rise mid-term, we absorb the difference until your term ends.";

const CS_TAPER_NOTE =
  "Bigger tiers cost slightly less per GB because one account is cheaper for us to run than two — " +
  "we pass that back. It's the only discount in the model.";

const CS_TIERS_NOTE = "Every tier is the whole product. The only difference is room.";

/* ── Comparison — managed cloud only (SPEC §5), June 2026 published rates ── */

const CS_COMPARE_ITEMS = [
  { label: "ColdStorage", value: 19, highlight: true },
  { label: "Google One", value: 50 },
  { label: "iCloud+", value: 60 },
  { label: "Dropbox", value: 60 },
];
const csCompareFormat = (v) => "$" + v + " /TB·yr";
const CS_COMPARE_CAPTION =
  "One terabyte, held for one year. Managed 2 TB cloud plans at June 2026 published rates, normalized per TB; " +
  "ColdStorage shown at its 1 TB tier, $18.99 a year. Each of the others also holds the keys to what you store.";

/* ── How it works — four honest steps ── */

const CS_HOW_STEPS = [
  {
    n: "01", icon: "ads_click", title: "Point it at what matters",
    body: "Pick your Photos library and the folders you'd hate to lose — or drag them in. It works like copying to a drive: no per-upload meter, no decisions.",
  },
  {
    n: "02", icon: "lock", title: "It scrambles and ships",
    body: "Everything is encrypted on your Mac before it leaves, then archived to deep storage somewhere else entirely. Newest photos go first, so the things you'd miss most are safe soonest.",
  },
  {
    n: "03", icon: "photo_library", title: "Browse everything, always",
    body: "Your whole archive stays browsable — file tree and thumbnails, instantly, without touching cold storage. Proof of safety you can look at.",
  },
  {
    n: "04", icon: "cloud_download", title: "Getting it back is a quote, then a wait",
    body: "A restore isn't instant — it's a recovery. Pick what you need, see the exact cost and ready-time, and nothing starts until you say go. Most people restore a folder, not the library.",
  },
];

/* ── Privacy commitments (V1-honest — claims match the architecture) ── */

const CS_PRIVACY_ROWS = [
  { label: "Scanning your files", value: "Never", icon: "visibility_off" },
  { label: "AI training on your data", value: "Never", icon: "smart_toy" },
  { label: "Ads, or selling data", value: "Never", icon: "block" },
  { label: "Human access", value: "Audit-logged, with your say-so", icon: "shield_person" },
  { label: "Leaving", value: "Export everything, anytime", icon: "output" },
];

const CS_KEY_ESCROW_LINE =
  "One more honest detail: today we hold your key — as escrow, so recovery works when you need it. " +
  "It's audit-logged, only ever used with your say-so, and we're moving it onto your device alone.";

/* ── FAQ pool — each page picks a subset ── */

const CS_FAQ = {
  where: {
    question: "Where is my data stored?",
    answer: "In Amazon's S3 Glacier Deep Archive — the industrial vault big companies use for the things they keep for decades. We're the simple, private layer on top: your files are scrambled on your Mac before they leave it, so what sits in that vault is data nobody can read.",
  },
  sync: {
    question: "Is this like iCloud or Dropbox?",
    answer: "No — those sync your working files and read them along the way. ColdStorage works like a drive you keep somewhere else: what you put is what's there, with no versioning. Putting things in feels like copying to an SSD. Getting things out is a recovery — a short wait and a quoted fee, shown before you commit.",
  },
  cost: {
    question: "Why does getting files back cost money?",
    answer: "Because pulling data out of deep storage has a real cost, and we pass it through at the raw rate we're charged — no markup. Most recoveries are small: a folder runs about fifty cents. Pulling back a full 500 GB archive at once is about $46. Either way you see the exact number first, and nothing's charged until you say go.",
  },
  lapse: {
    question: "What happens if I stop paying?",
    answer: "Nothing dramatic. Your archive goes read-only — untouched and browsable, with nothing new going in. You get about six months of grace and clear reminders, then a final warning long before anything is touched. We never delete over a lapsed card.",
  },
  privacy: {
    question: "Can ColdStorage see my photos?",
    answer: "Your files are encrypted on your Mac before they leave it, so what's stored is scrambled data nobody can read. Today we hold your key — as escrow, so recovery just works. It's audit-logged, only used with your say-so, and we're moving it onto your device alone. And in writing: never scanned, never sold, no AI trained on your data.",
  },
  floor: {
    question: "What's the 180-day minimum?",
    answer: "Deep storage bills a 180-day minimum per file, so something you delete on day 10 still bills out the rest of that window. Delete freely — it's your drive — we just want you to know how the meter runs before it matters.",
  },
  winddown: {
    question: "What if ColdStorage shuts down?",
    answer: "If we ever wind down, you get at least six months' notice to take your archive elsewhere before anything is deleted. It's a commitment we publish and stand behind: your archive shouldn't vanish because our company did.",
  },
};

/* ── Footer ── */

const CS_FOOTER = {
  tagline: "The offsite copy your drawer-SSD can't be.",
  columns: [
    { heading: "Product", links: [{ label: "How it works", href: "#how" }, { label: "Pricing", href: "#pricing" }, { label: "Privacy", href: "#privacy" }] },
    { heading: "Company", links: [{ label: "About" }, { label: "The wind-down promise" }, { label: "Transparency notes" }] },
    { heading: "Support", links: [{ label: "Help center" }, { label: "Status" }, { label: "Contact us" }] },
  ],
  legal: [{ label: "Privacy" }, { label: "Terms" }],
  copyright: "© 2026 ColdStorage",
};

/* ── Site helpers ── */

function useSolidNav() {
  const [solid, setSolid] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return solid;
}

function csScrollTo(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 88;
  window.scrollTo({ top, behavior: "smooth" });
}

/* Idempotent <style> injector — lets a section file ship its own scoped CSS
   (grids, custom controls) without the master page needing to know about it.
   Safe to call every time a section mounts; only writes the tag once. */
function csInjectStyle(id, css) {
  if (document.getElementById(id)) return;
  const tag = document.createElement("style");
  tag.id = id;
  tag.textContent = css;
  document.head.appendChild(tag);
}

/* Small mono caption line used under charts / tables */
function FinePrint({ children, style }) {
  return (
    <p style={{
      margin: "16px 0 0", font: "400 13px/1.55 var(--font-ui)",
      color: "var(--text-tertiary)", maxWidth: "64ch", textWrap: "pretty", ...style,
    }}>{children}</p>
  );
}

Object.assign(window, {
  CS_TERMS, CS_MATRIX, csPricingTiers, CS_ENTERPRISE, CS_RATE_LOCK, CS_TAPER_NOTE, CS_TIERS_NOTE,
  CS_COMPARE_ITEMS, csCompareFormat, CS_COMPARE_CAPTION,
  CS_HOW_STEPS, CS_PRIVACY_ROWS, CS_KEY_ESCROW_LINE, CS_FAQ, CS_FOOTER,
  useSolidNav, csScrollTo, FinePrint, csInjectStyle,
});
