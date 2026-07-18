/*
 * Section · Contact — the form, plus the two published addresses for people who'd rather use
 * their own mail client.
 *
 * The first form in the site, so a few things are established here rather than reused:
 *  - Field markup. The DS has no input primitive (see SPEC "Open decisions"); `Field` below is
 *    local and deliberately small, not a new shared component pretending to be DS.
 *  - Submission goes through `useFetcher`, not `<Form>`, so a send doesn't navigate — the page
 *    swaps the form for a confirmation in place.
 *
 * Turnstile is rendered EXPLICITLY (`turnstile.render`) rather than via the implicit
 * `class="cf-turnstile"` scan. Two reasons, both real: client-side route changes mean the
 * widget can mount after the script has already run its one-time scan, and a token is
 * single-use — after a rejected submit the widget has to be `reset()` or the next attempt
 * fails with `timeout-or-duplicate`.
 *
 * Copy is `CONTACT_PAGE` in content.ts; the validation contract is `contact.ts`, shared with
 * the route's action so the two can't disagree.
 */
import "./contact-form.css";
import * as React from "react";
import { useFetcher } from "react-router";
import { Reveal } from "~/lib/marketing/motion";
import { CONTACT_PAGE } from "~/lib/marketing/content";
import { CONTACT_FIELDS, contactSchema } from "~/lib/marketing/contact";
import type { ContactFieldError, ContactResult } from "~/lib/marketing/contact";
import { Button } from "~/components/ds/button";

/** The slice of the Turnstile browser API this component uses. */
type TurnstileApi = {
  render: (el: HTMLElement, opts: { sitekey: string; theme?: "light" | "auto" }) => string;
  reset: (widgetId?: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
    /** The script's own ready hook — it calls this once the API is usable. */
    onloadTurnstileCallback?: () => void;
  }
}

const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstileCallback";

export type ContactSectionProps = {
  /** Public half of the Turnstile pair, read server-side and passed down. Absent = unconfigured. */
  turnstileSiteKey?: string;
};

export function SectionContact({ turnstileSiteKey }: ContactSectionProps) {
  const fetcher = useFetcher<ContactResult>();
  const result = fetcher.data;
  const sending = fetcher.state !== "idle";
  const { form } = CONTACT_PAGE;

  const widgetRef = React.useRef<HTMLDivElement>(null);
  const widgetId = React.useRef<string | null>(null);

  // Mount the widget once the script's API is available. The script may load before or after
  // this effect runs, so handle both: render now if it's ready, otherwise wait for its onload.
  React.useEffect(() => {
    if (!turnstileSiteKey) return;

    const mount = () => {
      if (!widgetRef.current || widgetId.current !== null || !window.turnstile) return;
      widgetId.current = window.turnstile.render(widgetRef.current, {
        sitekey: turnstileSiteKey,
        theme: "light", // the site is light-only; "auto" would follow the OS and mismatch.
      });
    };

    if (window.turnstile) {
      mount();
      return;
    }

    window.onloadTurnstileCallback = mount;
    if (!document.querySelector(`script[src="${TURNSTILE_SCRIPT}"]`)) {
      const script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }, [turnstileSiteKey]);

  // A consumed token can't be replayed, so any non-success outcome needs a fresh one.
  React.useEffect(() => {
    if (result && result.status !== "ok" && widgetId.current !== null) {
      window.turnstile?.reset(widgetId.current);
    }
  }, [result]);

  const invalid = new Set<ContactFieldError>(
    result?.status === "invalid" ? result.fields : undefined
  );

  return (
    <section className="csf-band" data-screen-label="Contact" style={{ paddingTop: 72 }}>
      <div className="csf-container">
        <div className="csf-container--text" style={{ padding: 0 }}>
          <span className="csf-eyebrow">{CONTACT_PAGE.eyebrow}</span>
          <h1 className="csf-headline cs-contact__h1">{CONTACT_PAGE.title}</h1>
          <p className="csf-lead cs-contact__intro">{CONTACT_PAGE.intro}</p>
        </div>

        <div className="cs-contact" style={{ marginTop: 52 }}>
          <Reveal y={16}>
            <div className="cs-contact__card">
              {result?.status === "ok" ? (
                <div className="cs-contact__sent" role="status">
                  <p className="cs-contact__sent-title">{form.success.title}</p>
                  <p className="cs-contact__sent-body">{form.success.body}</p>
                </div>
              ) : (
                <fetcher.Form method="post" noValidate>
                  <div className="cs-contact__fields">
                    <Field
                      name={CONTACT_FIELDS.name}
                      label={form.name.label}
                      placeholder={form.name.placeholder}
                      autoComplete="name"
                      invalid={invalid.has("name")}
                      error={form.errors.name}
                    />
                    <Field
                      name={CONTACT_FIELDS.email}
                      label={form.email.label}
                      placeholder={form.email.placeholder}
                      type="email"
                      autoComplete="email"
                      invalid={invalid.has("email")}
                      error={form.errors.email}
                    />
                    <Field
                      name={CONTACT_FIELDS.message}
                      label={form.message.label}
                      placeholder={form.message.placeholder}
                      multiline
                      invalid={invalid.has("message")}
                      error={form.errors.message}
                    />
                  </div>

                  {turnstileSiteKey ? (
                    <div className="cs-contact__turnstile" ref={widgetRef} />
                  ) : null}

                  {/* Both non-field failures. `aria-live` so a screen reader hears the result
                      of a submit that otherwise changes nothing visible above the fold. */}
                  <div aria-live="polite">
                    {result?.status === "turnstile" ? (
                      <p className="cs-contact__error">{form.errors.turnstile}</p>
                    ) : null}
                    {result?.status === "failed" ? (
                      <p className="cs-contact__error">{form.errors.failed}</p>
                    ) : null}
                  </div>

                  <div className="cs-contact__actions">
                    <Button variant="primary" size="lg" type="submit" disabled={sending}>
                      {sending ? form.submitting : form.submit}
                    </Button>
                    <span className="cs-contact__note">{CONTACT_PAGE.responseNote}</span>
                  </div>
                </fetcher.Form>
              )}
            </div>
          </Reveal>

          <div className="cs-contact__aside">
            {CONTACT_PAGE.addresses.map((addr) => (
              <div key={addr.email}>
                <p className="cs-contact__addr-label">{addr.label}</p>
                <a className="cs-contact__addr-mail" href={`mailto:${addr.email}`}>
                  {addr.email}
                </a>
                <p className="cs-contact__addr-note">{addr.note}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

type FieldProps = {
  name: string;
  label: string;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  multiline?: boolean;
  invalid: boolean;
  error: string;
};

/** A labelled input or textarea. Local to this section on purpose — see the file header. */
function Field({
  name,
  label,
  placeholder,
  type = "text",
  autoComplete,
  multiline = false,
  invalid,
  error,
}: FieldProps) {
  const id = React.useId();
  const errorId = `${id}-error`;
  // `maxLength` mirrors the shared schema so the browser stops what the server would reject.
  const maxLength = maxLengthFor(name);
  const shared = {
    id,
    name,
    placeholder: placeholder || undefined,
    autoComplete,
    maxLength,
    required: true,
    "aria-invalid": invalid,
    "aria-describedby": invalid ? errorId : undefined,
  };

  return (
    <div className="cs-field">
      <label className="cs-field__label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea className="cs-field__textarea" {...shared} />
      ) : (
        <input className="cs-field__input" type={type} {...shared} />
      )}
      {invalid ? (
        <p className="cs-field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Pull the max length straight off the shared zod schema so the two can't drift (PILLAR3). */
function maxLengthFor(name: string): number | undefined {
  const field = contactSchema.shape[name as keyof typeof contactSchema.shape];
  return field?.maxLength ?? undefined;
}
