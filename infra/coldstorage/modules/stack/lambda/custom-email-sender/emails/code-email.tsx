/**
 * The one-time-code email — the only mail ColdStorage sends today, and for most people the first
 * thing the brand ever puts in front of them.
 *
 * Design notes, because email is not the web:
 *   · Every style is INLINE. Email clients strip <style> blocks with abandon; react-email's `style`
 *     props end up as inline attributes, which is the only styling that survives everywhere.
 *   · Colours are the DS tokens from site/app/styles/ds/colors.css, HARDCODED. CSS custom properties
 *     don't resolve in Outlook or Gmail, so the token values are copied here — the one place in the
 *     repo that duplicates them, and it's duplicated because it has to be, not to save an import.
 *   · Webfonts are best-effort (Apple Mail honours them, Gmail doesn't) so every family ends in a
 *     system fallback that carries the same weight and proportions.
 *   · The code is the reason the email exists, so it gets the biggest, most copy-pasteable treatment
 *     on the page: large, mono, letter-spaced, selectable text — NOT an image, never an image.
 *
 * The casing rule (ds/wordmark.tsx): the wordmark is lowercase `coldstorage`, the product name in
 * prose is `ColdStorage`. Both appear below, each in its own place.
 */
import { Body, Container, Font, Head, Heading, Hr, Html, Link, Preview, Section, Text } from "@react-email/components";
import type { CodeMessage } from "../messages.js";

/** DS colour tokens (site/app/styles/ds/colors.css), inlined — see the note above. */
const FROST_50 = "#F4F8FB";
const FROST_200 = "#DBE5EE";
const FROST_600 = "#586573";
const FROST_900 = "#141C24";
const ICEBERG_700 = "#2173A8";
const BG_APP = "#EDF3F8";

const UI_STACK = '"Hanken Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
const DISPLAY_STACK = `Outfit, ${UI_STACK}`;
const MONO_STACK = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export type CodeEmailProps = CodeMessage & {
  /** The plaintext one-time code, already decrypted. */
  code: string;
};

export function CodeEmail({ preheader, intro, code }: CodeEmailProps) {
  return (
    <Html lang="en">
      <Head>
        <Font
          fontFamily="Outfit"
          fallbackFontFamily="Helvetica"
          webFont={{ url: "https://fonts.gstatic.com/s/outfit/v11/QGYvz_MVcBeNP4NJuktqQ4E.woff2", format: "woff2" }}
          fontWeight={600}
          fontStyle="normal"
        />
      </Head>
      <Preview>{preheader}</Preview>
      <Body style={{ margin: 0, padding: 0, backgroundColor: BG_APP, fontFamily: UI_STACK }}>
        <Container style={{ maxWidth: "520px", margin: "0 auto", padding: "40px 24px" }}>
          <Section
            style={{
              backgroundColor: "#FFFFFF",
              borderRadius: "14px",
              border: `1px solid ${FROST_200}`,
              padding: "36px 32px",
            }}
          >
            <Heading
              as="h1"
              style={{
                margin: "0 0 28px",
                fontFamily: DISPLAY_STACK,
                fontSize: "22px",
                fontWeight: 600,
                letterSpacing: "-0.015em",
                color: FROST_900,
              }}
            >
              coldstorage
            </Heading>

            <Text style={{ margin: "0 0 20px", fontSize: "16px", lineHeight: "24px", color: FROST_900 }}>{intro}</Text>

            {/* The code. Big, mono, and plain selectable text so it can be copied on any device. */}
            <Section
              style={{
                backgroundColor: FROST_50,
                border: `1px solid ${FROST_200}`,
                borderRadius: "10px",
                padding: "18px 12px",
                textAlign: "center" as const,
              }}
            >
              <Text
                style={{
                  margin: 0,
                  fontFamily: MONO_STACK,
                  fontSize: "30px",
                  lineHeight: "36px",
                  fontWeight: 600,
                  letterSpacing: "0.18em",
                  // The letter-spacing above adds a trailing gap after the last digit; nudge the
                  // whole string back so it reads as centred rather than a hair to the right.
                  textIndent: "0.18em",
                  color: FROST_900,
                }}
              >
                {code}
              </Text>
            </Section>

            <Text style={{ margin: "20px 0 0", fontSize: "14px", lineHeight: "22px", color: FROST_600 }}>
              It works once, and not for long — so use it while it&rsquo;s fresh.
            </Text>

            <Hr style={{ borderColor: FROST_200, borderStyle: "solid", borderWidth: "1px 0 0", margin: "28px 0 20px" }} />

            <Text style={{ margin: 0, fontSize: "14px", lineHeight: "22px", color: FROST_600 }}>
              Didn&rsquo;t ask for a code? Someone typed your email address into ColdStorage. Nothing has happened to
              your account and nobody can get in without this code, so you can safely ignore this.
            </Text>
          </Section>

          <Text style={{ margin: "20px 0 0", textAlign: "center" as const, fontSize: "13px", color: FROST_600 }}>
            {/* The <Font> above emits a global `* { font-family: Outfit }`, and an element with no
                inline family inherits it — Outfit is the DISPLAY face and a legibility downgrade at
                13px (site ds/fonts.css says so outright). Every text element here states its own. */}
            <Link href="https://coldstorage.sh" style={{ fontFamily: UI_STACK, color: ICEBERG_700, textDecoration: "none" }}>
              coldstorage.sh
            </Link>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
