import type { Route } from "./+types/($lang).contact";
import { langUtils } from "~/lib/i18n/i18n-utils.server";
import { MarketingPage } from "~/components/marketing/marketing-page";
import { PageHero } from "~/components/marketing/sections/page-hero";
import { SectionContact } from "~/components/marketing/sections/contact-form";
import { CONTACT_PAGE } from "~/lib/marketing/content";
import { contactEnv } from "~/lib/env/contact-env.server";
import { sendContactMessage, verifyTurnstile } from "~/lib/marketing/contact.server";
import { CONTACT_FIELDS, contactSchema } from "~/lib/marketing/contact";
import type { ContactFieldError, ContactResult } from "~/lib/marketing/contact";

/**
 * `/contact` — the contact form, linked from the footer's Support column and from `/help`.
 *
 * The first route in this app with an `action`. Submissions go: Turnstile siteverify → zod →
 * CD2 → Ben's inbox, with the sender's address as `replyTo`. Copy is `CONTACT_PAGE` in
 * content.ts; the validation contract is `contact.ts`, shared with the form component.
 */
export function meta() {
  return [
    { title: "ColdStorage — Contact us" },
    {
      name: "description",
      content:
        "Questions about the app, your account, or a bill. Send a message and we'll reply by email.",
    },
  ];
}

export function loader({ params }: Route.LoaderArgs) {
  const { lang } = langUtils(params);
  // The site key is public, but it's passed down from the loader rather than read off
  // `window.env` so the widget container renders identically on the server and the client.
  return { lang, turnstileSiteKey: contactEnv.PUBLIC_TURNSTILE_SITE_KEY };
}

export async function action({ request }: Route.ActionArgs): Promise<ContactResult> {
  const formData = await request.formData();

  // Spam check first — no reason to validate or send anything a bot submitted.
  const token = formData.get(CONTACT_FIELDS.token);
  const passed = await verifyTurnstile(
    typeof token === "string" ? token : null,
    request.headers.get("cf-connecting-ip") ?? undefined
  );
  if (!passed) return { status: "turnstile" };

  const parsed = contactSchema.safeParse({
    name: formData.get(CONTACT_FIELDS.name),
    email: formData.get(CONTACT_FIELDS.email),
    message: formData.get(CONTACT_FIELDS.message),
  });
  if (!parsed.success) {
    // Report every bad field at once — fixing one at a time is a miserable way to fill a form.
    const fields = [
      ...new Set(parsed.error.issues.map((i) => i.path[0] as ContactFieldError)),
    ];
    return { status: "invalid", fields };
  }

  const sent = await sendContactMessage(parsed.data, {
    userAgent: request.headers.get("user-agent") ?? undefined,
  });
  return sent ? { status: "ok" } : { status: "failed" };
}

export default function Contact({ loaderData }: Route.ComponentProps) {
  return (
    <MarketingPage>
      <PageHero content={CONTACT_PAGE} />
      <SectionContact turnstileSiteKey={loaderData.turnstileSiteKey} />
    </MarketingPage>
  );
}
