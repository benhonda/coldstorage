/* Canonical landing copy — verbatim from Concept 2 (uploads/landing-copy.md).
   Concepts 3+ read from here so copy stays identical across concepts. */
(function () {
  const LC = {
    hero: {
      words: ["Private.", "Cost-effective.", "Simple."],
      lead: "ColdStorage backs up your photos and files, so a dead laptop or a wiped drive doesn't take them with it.",
      cta: "Download for Mac",
      note: "Free to start: 25 GB, no card.",
    },
    how: {
      eyebrow: "How it works",
      title: "Drag in what you want to keep",
      body: "Open the app, drag in the photos or files you want to keep, and they upload. Pull in your whole camera roll or a single folder — whatever you drop in gets encrypted on your Mac and stored. There's no setup, and nothing to manage after.",
    },
    privacy: {
      eyebrow: "Privacy",
      title: "Only you can open them",
      lead: "Your files are encrypted on your Mac before they leave it, with a key only you hold. We never get that key, so we can't open your files. Only you can.",
      steps: [
        { icon: "enhanced_encryption", title: "Encrypted on your Mac", body: "Files are scrambled before they leave your machine." },
        { icon: "key", title: "The key stays with you", body: "We never get it, and there's no copy on our side." },
        { icon: "visibility_off", title: "We store what we can't read", body: "What sits with us is data only you can open." },
      ],
    },
    pricing: {
      eyebrow: "Pricing",
      title: "Start with 25\u00a0GB free, no card",
      lead: "When you need more room, pick a size. Getting files back has its own simple numbers — they're on the second tab.",
      leadNoTabs: "When you need more room, pick a size. Getting files back has its own simple numbers — they're right below.",
      tiers: [
        { size: "25 GB", year: "Free", month: "—", free: true },
        { size: "500 GB", year: "$9.99", month: "$0.83" },
        { size: "1 TB", year: "$18.99", month: "$1.58" },
        { size: "2 TB", year: "$36.99", month: "$3.08" },
        { size: "5 TB", year: "$90.99", month: "$7.58" },
        { size: "10 TB", year: "$180.99", month: "$15.08" },
      ],
      moreLead: "More than 10 TB?",
      moreLink: "Get in touch",
      renewNote: "Plans renew once a year, and we tell you before they do.",
      retrievalTitle: "Getting files back",
      retrievalLead: "Storing is your yearly plan. Pulling files back out costs what it costs us to move them — no markup. Here are the numbers, so you can work it out yourself.",
      retrievalRows: [
        { label: "First 1 GB each month", value: "Free" },
        { label: "Every GB you pull back", value: "$0.09" },
        { label: "Flat fee per recovery", value: "$0.50" },
      ],
      readyNote: "Ready in a day or two, or sooner if you pay a bit to hurry it.",
      callout: "Pulling a lot of data back out is a real cost to move, and we pass it through with no markup.",
      calloutLink: "How deep storage works →",
      finePrint: "Plus a small bring-up cost and card processing (~5%). The exact total is always shown before you confirm — computed exactly, never rounded up. Free monthly amount is 1 GB on paid plans, 200 MB on the free plan.",
    },
    faq: {
      eyebrow: "Questions",
      title: "Fair to ask",
      items: [
        { question: "How is this different from iCloud, Google Drive, or Dropbox?", answer: "Those keep your files live and instantly openable, and you pay for that every month. ColdStorage is for files you want kept but rarely open, so it costs a lot less — and your files are encrypted with a key only you hold, so we can't read them." },
        { question: "Can you see my files?", answer: "No. They're encrypted on your Mac before they upload, with a key only you hold. We never get the key, so we can't open them." },
        { question: "Is there a free plan?", answer: "Yes — 25 GB free, forever, no card." },
        { question: "What does it cost to get my files back?", answer: "Each month you can pull back 1 GB for free. Beyond that, you pay only what it costs us to move the data, and you always see the amount before you agree." },
        { question: "Can I get all my files back out?", answer: "Anytime. You can export your whole archive and take it elsewhere — nothing's locked in." },
      ],
    },
    close: {
      eyebrow: "ColdStorage for Mac",
      title: "Try it with 25\u00a0GB free",
      lead: "No card, and nothing to cancel if it's not for you.",
      cta: "Download for Mac",
    },
    nav: {
      links: [
        { label: "How it works", href: "#how" },
        { label: "Privacy", href: "#privacy" },
        { label: "Pricing", href: "#pricing" },
        { label: "FAQ", href: "#faq" },
      ],
      cta: "Download for Mac",
    },
    footer: {
      tagline: "For the photos and files you want kept.",
      columns: [
        { heading: "Product", links: [{ label: "How it works", href: "#how" }, { label: "Pricing", href: "#pricing" }, { label: "Privacy", href: "#privacy" }, { label: "FAQ", href: "#faq" }] },
        { heading: "Company", links: [{ label: "About" }, { label: "Open source" }, { label: "Transparency notes" }] },
        { heading: "Support", links: [{ label: "Help center" }, { label: "Status" }, { label: "Contact us" }] },
      ],
      legal: [{ label: "Privacy" }, { label: "Terms" }],
      copyright: "© 2026 ColdStorage",
    },
  };
  Object.assign(window, { LC });
})();
