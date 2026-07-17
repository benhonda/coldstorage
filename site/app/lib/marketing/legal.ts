/*
 * Legal-page content — the single source of truth for the /terms, /privacy, and
 * /refunds routes (Paddle domain-review requires all three, live and linked in nav).
 *
 * Copy is plain and factual to match the marketing voice, and every claim matches the
 * actual shipped architecture: on-device (client-side) encryption, S3 Glacier Deep Archive
 * in AWS Canada (ca-central-1), TRUE ZERO-KNOWLEDGE keys (recovery-code-only — we store only
 * ciphertext and cannot decrypt anyone's files or key), and Paddle as Merchant of Record.
 * The Privacy Policy is layered: a plain-English summary up top, then thorough detail that
 * satisfies Canadian PIPEDA, EU/UK GDPR, and California CCPA/CPRA.
 *
 * English only; French translation is not planned — the /fr routes render this same
 * English text. Do not machine-translate legal copy.
 *
 * Entity/contact values below are the PRODUCTION account details, confirmed with Ben
 * 2026-07-17: seller "ColdStorage" (Paddle account registered lowercase; the lowercase
 * wordmark is a logo treatment, prose uses brand case), Burlington ON Canada, legal@ +
 * support@ on m.coldstorage.sh, account database in AWS us-east-2, file storage in AWS Canada.
 */

/** The seller of record, written in brand case. (The Paddle account is registered lowercase
 *  "coldstorage" — the lowercase wordmark is a logo treatment; prose uses "ColdStorage".) */
export const LEGAL_SELLER = "ColdStorage";
/** Registered business mailing address — shown as the controller/seller contact. */
export const LEGAL_ADDRESS = "2290 Avalon Dr., Burlington, Ontario, Canada";
/** Governing-law jurisdiction for the Terms. */
export const JURISDICTION = "the Province of Ontario, Canada";
/** Customer-facing support contact — must be monitored. */
export const SUPPORT_EMAIL = "support@m.coldstorage.sh";
/** Privacy / data-rights / legal contact — a monitored alias distinct from support. */
export const LEGAL_EMAIL = "legal@m.coldstorage.sh";
/** Where the account database (Neon) lives — for the data-residency / transfers section. */
export const DB_REGION = "the United States (AWS us-east-2)"; // Neon account database
/** How quickly we purge data after a deletion request — must be a window we can honor. */
export const DELETION_WINDOW = "30 days";
/** Human-readable "last updated" stamp shown on every legal page. */
export const LEGAL_UPDATED = "July 17, 2026";

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
  lede: `These terms are an agreement between you and ${LEGAL_SELLER} ("we", "us"), covering your use of ColdStorage, a Mac app and cloud-storage subscription. By downloading the app or starting a subscription, you agree to them. If you don't agree, please don't use ColdStorage.`,
  sections: [
    {
      heading: "1. What ColdStorage is",
      blocks: [
        p("ColdStorage is a downloadable macOS application that backs up photos and files you choose to long-term cloud storage. You pick what to upload; the app encrypts each file on your Mac before it leaves the machine, and stores the encrypted data in Amazon S3 Glacier Deep Archive."),
        p("It is not a sync service and it keeps no version history. Getting files back is a recovery, not an instant download: you are shown an exact fee and wait time first, and nothing starts until you approve it."),
      ],
    },
    {
      heading: "2. Who can use ColdStorage",
      blocks: [
        p("You must be at least 18 (or the age of majority where you live) and able to enter a binding contract to use ColdStorage."),
        p("Sign-in is passwordless: you use Sign in with Google or a one-time code sent to your email, so there are no passwords to manage. You're responsible for keeping your devices, your account, and especially your recovery code (see section 7) secure, and for everything that happens under your account."),
      ],
    },
    {
      heading: "3. Your subscription",
      blocks: [
        p("The app is free to download. Storage is a paid subscription, sold in capacity tiers (500 GB, 1 TB, and 2 TB) on a prepaid term of one, two, three, or five years, charged up front."),
        p("Each term is a rate lock — that many years at the price shown when you buy. If our own costs rise during your term, we absorb the difference until the term ends."),
        p("Subscriptions renew automatically at the end of the term unless you cancel. We remind you before a renewal is charged."),
        p("Payments are processed by Paddle.com, our Merchant of Record and reseller. Paddle handles billing, tax, and receipts; your card details never touch our systems. Your purchase is also subject to Paddle's buyer terms."),
      ],
    },
    {
      heading: "4. Cancelling, and what happens if a payment lapses",
      blocks: [
        p("You can cancel at any time from the app or the customer portal. See our Refund Policy for money-back terms."),
        p("If a subscription lapses or you cancel, your archive is not deleted. It becomes read-only — browsable, with nothing new going in — and is kept through a grace period of about six months, with clear reminders and a final warning before anything is removed. We never delete an archive over a single lapsed card."),
      ],
    },
    {
      heading: "5. Recovering your files",
      blocks: [
        p("Retrieving data from deep storage carries a real cost that Amazon charges us. We pass that through at cost, with no markup. Before any recovery, you see the exact fee and ready-time and must approve it. Retrieval fees are usage charges for work performed on your request and are separate from your subscription."),
      ],
    },
    {
      heading: "6. Your files and your responsibilities",
      blocks: [
        p("Your files are yours. You keep all rights to what you upload, and you are responsible for having the right to store it and for using ColdStorage lawfully."),
        list([
          "Only upload data you own or have permission to store.",
          "Don't use ColdStorage to store or share unlawful content, or to break the law.",
          "Don't upload malware, or anything that infringes someone else's rights.",
          "Don't try to break, overload, reverse-engineer, or gain unauthorized access to the service or to other accounts.",
          "Keep your Mac, your account, and your recovery code secure.",
        ]),
      ],
    },
    {
      heading: "7. Your encryption key and recovery code",
      blocks: [
        p("Your files are encrypted on your Mac before they upload, with a key that only exists on your devices. We store only scrambled data and an encrypted copy of your key that we cannot unlock. This is what people mean by \"zero-knowledge\": we cannot read your files, and we cannot recover your key for you."),
        p("When you set up your account you're shown a one-time recovery code. It is the only thing that can unlock your key on a new device, so keep it somewhere safe. If you lose your recovery code and you're signed out of every device, your files cannot be recovered — not by you, and not by us. That trade-off is what makes the encryption real, and we'd rather be honest about it than pretend otherwise."),
      ],
    },
    {
      heading: "8. Availability",
      blocks: [
        p("We work to keep the service available but don't guarantee uninterrupted access, and deep-archive recovery is inherently not instant by design — retrievals take time and carry a fee you approve first. We may occasionally pause the service for maintenance or updates."),
        p("If we ever wind the service down, you get at least six months' notice to take your archive elsewhere before anything is deleted. It's a commitment we publish and stand behind: your archive shouldn't disappear because our business did."),
      ],
    },
    {
      heading: "9. Disclaimers",
      blocks: [
        p("ColdStorage is provided \"as is\" and \"as available,\" without warranties of any kind, express or implied, to the fullest extent the law allows. We don't warrant that the service will be uninterrupted, error-free, or fit for every purpose. Nothing here affects consumer-protection rights you have that can't be waived under the law where you live."),
      ],
    },
    {
      heading: "10. Liability",
      blocks: [
        p("To the fullest extent permitted by law, we are not liable for indirect or consequential loss, and our total liability is limited to the amount you paid for your subscription in the twelve months before the claim. Nothing here limits liability that can't be limited by law — including liability for death or personal injury caused by negligence, or for fraud."),
      ],
    },
    {
      heading: "11. Indemnification",
      blocks: [
        p("If someone brings a claim against us because of how you used ColdStorage or content you stored — for example, because you didn't have the right to store it — you agree to cover the reasonable costs of dealing with that claim, to the extent the law allows."),
      ],
    },
    {
      heading: "12. Suspension and closing an account",
      blocks: [
        p("We may suspend or close an account that breaks these terms — for example, storing unlawful content or trying to attack the service — and where we reasonably can, we'll tell you why and give you a chance to put things right first. You can close your account at any time. A subscription that simply lapses is covered by section 4, not this one — we don't delete an archive over a lapsed payment."),
      ],
    },
    {
      heading: "13. Changes to these terms",
      blocks: [
        p("We may update these terms as the product changes. If a change is material, we'll give reasonable notice. Continuing to use ColdStorage after a change means you accept the updated terms."),
      ],
    },
    {
      heading: "14. Governing law and contact",
      blocks: [
        p(`These terms are governed by the laws of ${JURISDICTION}, and any disputes will be handled by the courts there — without affecting consumer-protection rights you have where you live. You can reach us at ${SUPPORT_EMAIL}, or by mail at ${LEGAL_ADDRESS}.`),
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
        p("This guarantee is on top of any refund rights you already have under the law where you live — it doesn't replace them."),
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
      heading: "The short version",
      blocks: [
        list([
          "Your files are encrypted on your Mac before they upload. We store scrambled data we cannot read.",
          "We collect the minimum needed to run your account and subscription — mainly your email.",
          "We never scan your files, train AI on them, show ads, or sell your data.",
          "We use no analytics and no tracking cookies.",
          "You can see, correct, export, or delete your data at any time.",
        ]),
        p("The rest of this page is the detail behind those points, written to satisfy Canadian (PIPEDA), European/UK (GDPR), and California (CCPA/CPRA) privacy law."),
      ],
    },
    {
      heading: "Who we are",
      blocks: [
        p(`ColdStorage is operated by ${LEGAL_SELLER} at ${LEGAL_ADDRESS}. We are the party responsible for your personal data (the "data controller"). For anything about privacy or your data, email ${LEGAL_EMAIL}.`),
      ],
    },
    {
      heading: "What we collect",
      blocks: [
        list([
          "Your email address, so you can sign in and we can reach you about your account. Sign-in is passwordless, managed through Amazon Cognito.",
          "Your name — if you sign in with Google (Google shares it) or enter a display name during setup.",
          "Your subscription and billing status: your plan and whether it's active. Payment is handled by Paddle; your card details go to Paddle, never to us.",
          "A record that you accepted these terms, and when.",
          "Your answers to the two optional setup questions, if you choose to answer them — they're skippable, and we use them only to understand who ColdStorage is for.",
          "Records of any file retrievals you request, so we can carry them out and bill them at cost.",
          "Your files — stored only as encrypted data we cannot read. They're scrambled on your Mac before they upload.",
          "Basic technical data such as IP addresses and timestamps in our servers' logs, used to keep the service running and secure.",
        ]),
      ],
    },
    {
      heading: "How we use it",
      blocks: [
        p("We use what we collect only to run ColdStorage: to give you your account, storage, and subscription; to process payments, tax, and refunds through Paddle; to keep the service secure and prevent abuse; to answer you when you get in touch; and — only if you answer them — to learn who ColdStorage is for from the optional setup questions."),
        p("For anyone in the EU or UK, our legal bases under the GDPR are: performing our contract with you (your account, storage, and subscription), meeting legal obligations (tax and accounting), our legitimate interests (a secure, working service), and your consent (the optional survey and Google sign-in, which you can withdraw at any time)."),
      ],
    },
    {
      heading: "What we never do",
      blocks: [
        list([
          "We never scan your files.",
          "We never train AI on your data.",
          "We never run ads or sell your data.",
          "We use no third-party analytics, advertising, or tracking of any kind.",
        ]),
      ],
    },
    {
      heading: "Your files and your encryption key",
      blocks: [
        p("Your files are encrypted on your Mac with a key that only exists on your devices. We store only scrambled data and an encrypted copy of your key that we cannot unlock — this is what \"zero-knowledge\" means. We cannot read your files, and we cannot recover your key for you."),
        p("You're shown a one-time recovery code at setup. It is the only thing that can unlock your key on a new device. If you lose it and you're signed out of every device, your files cannot be recovered — not by you, and not by us. That's the honest cost of encryption we can't bypass."),
      ],
    },
    {
      heading: "Who processes your data",
      blocks: [
        p("We keep the list of companies that help us run ColdStorage short, and each only handles the data it needs for its job:"),
        list([
          "Amazon Web Services — encrypted file storage (S3 Glacier Deep Archive, in Canada) and account sign-in (Cognito).",
          "Paddle.com — payments, billing, and tax, as our Merchant of Record. Your card details go to Paddle, not to us.",
          "Neon — the database holding your account record (name, plan status, and your encrypted key — never your files or card details).",
          "Google — only if you choose Sign in with Google, to confirm who you are. You can use an email code instead and skip Google entirely.",
          "Vercel — hosting for our website and account service.",
        ]),
        p("We don't use any advertising, analytics, or tracking companies."),
      ],
    },
    {
      heading: "Where your data is stored, and international transfers",
      blocks: [
        p("ColdStorage runs on infrastructure in more than one country:"),
        list([
          "Your encrypted files are stored with Amazon Web Services in Canada (the ca-central-1 region, Montréal).",
          `Your account database is hosted by Neon in ${DB_REGION}.`,
          "Payments and tax are handled by Paddle, which operates internationally.",
          "If you sign in with Google, Google processes that sign-in on its global infrastructure.",
          "Our website and account service are hosted by Vercel.",
        ]),
        p("If you're in the EU, UK, or elsewhere, this means your data may be processed outside your country. Where that happens, we rely on our providers' standard contractual clauses and equivalent safeguards."),
      ],
    },
    {
      heading: "Cookies",
      blocks: [
        p("Our website uses a single first-party cookie that remembers your light/dark preference. It doesn't track you, and it isn't shared with anyone. We set no analytics or advertising cookies."),
        p("When you buy or manage a subscription, Paddle's checkout may set cookies it needs to process the payment; those are governed by Paddle's own privacy policy."),
      ],
    },
    {
      heading: "How long we keep your data, and deleting it",
      blocks: [
        p("While your account is open, we keep your account and subscription data for as long as you use the service."),
        p(`You can ask us to delete your account and everything in it at any time — email ${LEGAL_EMAIL} from your account address. We remove your account record and stored files within ${DELETION_WINDOW}, except anything we're required to keep for tax or legal reasons (billing records held by Paddle, for example).`),
        p("If your subscription lapses, your archive goes read-only and is kept through a roughly six-month grace period with reminders before anything is removed — we never delete over a single lapsed card. If we ever wind the service down, you get at least six months' notice to take your archive elsewhere first."),
      ],
    },
    {
      heading: "Your rights",
      blocks: [
        p(`Wherever you live, you can ask what personal data we hold about you and get a copy, correct anything that's wrong, export your data (you can pull your files back anytime, and ask us for the rest), and delete your account and data. To do any of these, email ${LEGAL_EMAIL}; we'll respond within the time your local law requires (30 days in Canada, one month under the GDPR).`),
        p("If you're in the EU or UK (GDPR), you also have the right to object to or restrict certain processing, to withdraw consent, and to data portability, and you can lodge a complaint with your local data protection authority."),
        p("If you're in Canada (PIPEDA), you can access and correct your personal information and complain to the Office of the Privacy Commissioner of Canada."),
        p("If you're in California (CCPA/CPRA), you have the right to know what we collect, to delete it, to correct it, and not to be treated differently for exercising these rights. We do not sell or share your personal information, and we never have."),
      ],
    },
    {
      heading: "How we protect your data",
      blocks: [
        list([
          "Your files are encrypted on your Mac before they leave it, with a key we can't unlock.",
          "Everything travels over encrypted connections (TLS).",
          "Stored files are encrypted again at rest by Amazon S3, on top of your own encryption.",
          "Each account can only reach its own files, enforced by per-user cloud permissions and short-lived credentials — no account can read another's data, and we hold no long-lived keys to your storage.",
        ]),
        p("No system is perfectly secure, but zero-knowledge encryption means that even in a worst case, what sits in storage is data nobody but you can open."),
      ],
    },
    {
      heading: "Children",
      blocks: [
        p(`ColdStorage is for adults. You must be at least 18 (or the age of majority where you live) to use it, and it isn't directed at children. We don't knowingly collect data from anyone under 18; if you believe a child has given us personal data, email ${LEGAL_EMAIL} and we'll delete it.`),
      ],
    },
    {
      heading: "Changes to this policy",
      blocks: [
        p("We may update this policy as the product changes. If a change is material, we'll give reasonable notice. The date at the top always shows when it was last updated."),
      ],
    },
    {
      heading: "Contact",
      blocks: [
        p(`For privacy questions or to exercise any of your rights, email ${LEGAL_EMAIL}, or write to ${LEGAL_SELLER} at ${LEGAL_ADDRESS}. For general help, use ${SUPPORT_EMAIL}.`),
      ],
    },
  ],
};

/** All three, for anything that needs to enumerate the legal pages. */
export const LEGAL_PAGES = { terms: TERMS_PAGE, refunds: REFUND_PAGE, privacy: PRIVACY_PAGE } as const;
