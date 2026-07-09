/*
 * Legal-page content — the single source of truth for the /terms, /privacy, and
 * /refunds routes (Paddle domain-review requires all three, live and linked in nav).
 *
 * Copy is plain and factual to match the marketing voice, and every claim matches the
 * actual architecture (on-device encryption, S3 Glacier Deep Archive, key-escrow-today,
 * Paddle as Merchant of Record). English only for launch; the /fr routes render this same
 * text until legal copy is translated (a translation of legal text is deliberately deferred
 * — do not machine-translate legal copy).
 *
 * ⚠️ CONFIRM BEFORE PUBLISHING (Paddle rejects on legal-entity mismatch):
 *   - LEGAL_SELLER must be Ben's EXACT registered sole-proprietor name.
 *   - JURISDICTION must be the province/country Ben operates the sole proprietorship from.
 *   - SUPPORT_EMAIL must be a monitored mailbox.
 */

/** The registered seller of record (sole proprietor). Paddle Terms must name this exactly. */
export const LEGAL_SELLER = "Ben Honda"; // TODO(ben): confirm exact registered legal name
/** Governing-law jurisdiction for the Terms. */
export const JURISDICTION = "the Province of Ontario, Canada"; // TODO(ben): confirm
/** Customer-facing contact — referenced by the refund policy; must be monitored. */
export const SUPPORT_EMAIL = "support@m.coldstorage.sh";
/** Human-readable "last updated" stamp shown on every legal page. */
export const LEGAL_UPDATED = "July 8, 2026";

/** A block of legal copy: a paragraph or a bulleted list. */
export type LegalBlock = { kind: "p"; text: string } | { kind: "list"; items: string[] };
export type LegalSection = { heading: string; blocks: LegalBlock[] };
export type LegalPageContent = {
  slug: "terms" | "privacy" | "refunds";
  title: string;
  updated: string;
  lede: string;
  sections: LegalSection[];
};

const p = (text: string): LegalBlock => ({ kind: "p", text });
const list = (items: string[]): LegalBlock => ({ kind: "list", items });

/* ─────────────────────────────────  Terms  ────────────────────────────────── */

export const TERMS_PAGE: LegalPageContent = {
  slug: "terms",
  title: "Terms of Service",
  updated: LEGAL_UPDATED,
  lede: `These terms cover your use of ColdStorage, a Mac app and cloud-storage subscription operated by ${LEGAL_SELLER} (a sole proprietor, "we", "us"). By downloading the app or starting a subscription, you agree to them.`,
  sections: [
    {
      heading: "1. What ColdStorage is",
      blocks: [
        p("ColdStorage is a downloadable macOS application that backs up photos and files you choose to long-term cloud storage. You pick what to upload; the app encrypts each file on your Mac before it leaves the machine, and stores the encrypted data in Amazon S3 Glacier Deep Archive."),
        p("It is not a sync service and it keeps no version history. Getting files back is a recovery, not an instant download: you are shown an exact fee and wait time first, and nothing starts until you approve it."),
      ],
    },
    {
      heading: "2. Your subscription",
      blocks: [
        p("The app is free to download. Storage is a paid subscription, sold in capacity tiers (500 GB, 1 TB, and 2 TB) on a prepaid term of one, two, three, or five years, charged up front."),
        p("Each term is a rate lock — that many years at the price shown when you buy. If our own costs rise during your term, we absorb the difference until the term ends."),
        p("Subscriptions renew automatically at the end of the term unless you cancel. We remind you before a renewal is charged."),
        p("Payments are processed by Paddle.com, our Merchant of Record and reseller. Paddle handles billing, tax, and receipts; your card details never touch our systems. Your purchase is also subject to Paddle's buyer terms."),
      ],
    },
    {
      heading: "3. Cancelling, and what happens if a payment lapses",
      blocks: [
        p("You can cancel at any time from the app or the customer portal. See our Refund Policy for money-back terms."),
        p("If a subscription lapses or you cancel, your archive is not deleted. It becomes read-only — browsable, with nothing new going in — and is kept through a grace period of about six months, with clear reminders and a final warning before anything is removed. We never delete an archive over a single lapsed card."),
      ],
    },
    {
      heading: "4. Recovering your files",
      blocks: [
        p("Retrieving data from deep storage carries a real cost that Amazon charges us. We pass that through at cost, with no markup. Before any recovery, you see the exact fee and ready-time and must approve it. Retrieval fees are usage charges for work performed on your request and are separate from your subscription."),
      ],
    },
    {
      heading: "5. Your files and your responsibilities",
      blocks: [
        p("Your files are yours. You keep all rights to what you upload, and you are responsible for having the right to store it and for using ColdStorage lawfully."),
        list([
          "Only upload data you own or have permission to store.",
          "Don't use ColdStorage to store unlawful content or to break the law.",
          "Keep your Mac and account credentials secure.",
        ]),
      ],
    },
    {
      heading: "6. Your encryption key",
      blocks: [
        p("Your files are encrypted on your Mac with a key tied to your account. Today we hold that key in escrow so recovery works when you need it. Access to it is audit-logged and only ever used with your say-so. We are moving toward holding the key on your device alone; this section will be updated when that ships."),
      ],
    },
    {
      heading: "7. Availability and our wind-down promise",
      blocks: [
        p("We work to keep the service available but don't guarantee uninterrupted access, and deep-archive recovery is inherently not instant by design."),
        p("If we ever wind the service down, you get at least six months' notice to take your archive elsewhere before anything is deleted. It's a commitment we publish and stand behind: your archive shouldn't disappear because our business did."),
      ],
    },
    {
      heading: "8. Liability",
      blocks: [
        p("ColdStorage is provided on an \"as is\" basis. To the fullest extent permitted by law, we are not liable for indirect or consequential loss, and our total liability is limited to the amount you paid for your subscription in the twelve months before the claim. Nothing here limits liability that can't be limited by law."),
      ],
    },
    {
      heading: "9. Changes to these terms",
      blocks: [
        p("We may update these terms as the product changes. If a change is material, we'll give reasonable notice. Continuing to use ColdStorage after a change means you accept the updated terms."),
      ],
    },
    {
      heading: "10. Governing law and contact",
      blocks: [
        p(`These terms are governed by the laws of ${JURISDICTION}. Questions about them can go to ${SUPPORT_EMAIL}.`),
      ],
    },
  ],
};

/* ────────────────────────────────  Refunds  ───────────────────────────────── */

export const REFUND_PAGE: LegalPageContent = {
  slug: "refunds",
  title: "Refund Policy",
  updated: LEGAL_UPDATED,
  lede: "We want you to be happy with ColdStorage. Our guarantee is simple, with no fine print.",
  sections: [
    {
      heading: "14-day money-back guarantee",
      blocks: [
        p(`If you're not satisfied for any reason, email ${SUPPORT_EMAIL} within 14 days of your purchase and we'll refund your subscription in full. No questions asked.`),
      ],
    },
    {
      heading: "How to request a refund",
      blocks: [
        p(`Send us a note at ${SUPPORT_EMAIL} from the email on your account within 14 days of the charge. Payments and refunds are handled by Paddle.com, our Merchant of Record, and the refund is returned to your original payment method.`),
      ],
    },
    {
      heading: "About retrieval fees",
      blocks: [
        p("Recovering files from deep storage is a separate, optional action with its own fee — charged at Amazon's raw cost with no markup, and always shown and approved by you before it runs. Because a retrieval is work performed at your request, those usage fees aren't covered by the subscription guarantee above. Your subscription itself is always covered."),
      ],
    },
  ],
};

/* ────────────────────────────────  Privacy  ───────────────────────────────── */

export const PRIVACY_PAGE: LegalPageContent = {
  slug: "privacy",
  title: "Privacy Policy",
  updated: LEGAL_UPDATED,
  lede: "Privacy claims tend to inflate. Ours match how ColdStorage is actually built — what it does, and what it doesn't.",
  sections: [
    {
      heading: "What we collect",
      blocks: [
        list([
          "Account: the email address you sign up with, managed through Amazon Cognito.",
          "Subscription: your plan and billing status, handled by Paddle.com (our Merchant of Record). Your card details go to Paddle, never to us.",
          "Your files: stored as encrypted data we cannot read. They're scrambled on your Mac before upload, so what sits in storage is content nobody but you can open.",
        ]),
      ],
    },
    {
      heading: "What we never do",
      blocks: [
        list([
          "We never scan your files.",
          "We never train AI on your data.",
          "We never run ads or sell your data.",
        ]),
      ],
    },
    {
      heading: "Human access and your encryption key",
      blocks: [
        p("Today we hold your encryption key in escrow so recovery works when you need it. Any human access is audit-logged and only ever happens with your say-so. We're working toward holding the key on your device alone."),
      ],
    },
    {
      heading: "Who processes your data",
      blocks: [
        p("We use a small set of providers to run the service: Amazon Web Services (encrypted storage and account identity) and Paddle.com (payments and tax). They process data only to provide these functions."),
      ],
    },
    {
      heading: "Keeping and deleting your data",
      blocks: [
        p("You can export everything, at any time. If your subscription lapses, your archive goes read-only and is kept through a grace period with reminders before anything is removed — we never delete over a single lapsed card. If we ever wind the service down, you get at least six months' notice to take your archive elsewhere first."),
      ],
    },
    {
      heading: "Your rights and contact",
      blocks: [
        p(`You can ask what we hold about you, correct it, or have it deleted. Reach us at ${SUPPORT_EMAIL}. If we make a material change to this policy, we'll give reasonable notice.`),
      ],
    },
  ],
};

/** All three, for anything that needs to enumerate the legal pages. */
export const LEGAL_PAGES = { terms: TERMS_PAGE, refunds: REFUND_PAGE, privacy: PRIVACY_PAGE } as const;
