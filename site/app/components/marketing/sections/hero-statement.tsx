/*
 * Section — Hero · statement: three revealed words over a wide media stage.
 * Ported from `Claude design · v4-sections.jsx` → `SectionV4Hero`:
 * IIFE/`window` globals → imports, `csInjectStyle` → a co-located stylesheet,
 * `<image-slot>` → <MediaFrame> (see SPEC "Open decisions" — media pending).
 * Structure + inline styles kept faithful so re-pulls stay a clean diff.
 */
import "./hero-statement.css";
import { Fragment } from "react";
import { Reveal } from "~/lib/marketing/motion";
import { DOWNLOAD_START_PATH } from "~/lib/marketing/download";
import { HERO } from "~/lib/marketing/content";
import { Button } from "~/components/ds/button";
import { MediaFrame } from "~/components/marketing/shared/media-frame";

/**
 * How long the whole headline takes to finish arriving, first word to last.
 *
 * The stagger is DERIVED from this rather than being a fixed per-word delay, because the two
 * are not interchangeable once the headline changes length: upstream's flat `i * 140ms` was
 * tuned for a three-word headline, and at seven words it would still be revealing after the
 * lead (420ms) and CTA (540ms) had already landed — the page would assemble backwards. Fixing
 * the total instead means the headline always completes before the lead starts, whatever it says.
 */
const HEADLINE_SWEEP_MS = 300;

export function SectionHeroStatement() {
  const step = HERO.words.length > 1 ? HEADLINE_SWEEP_MS / (HERO.words.length - 1) : 0;

  return (
    <section className="csf-band" data-screen-label="Hero" style={{ paddingTop: 72 }}>
      <div className="csf-container" style={{ textAlign: "center" }}>
        {/* 26ch over the old 22ch: the headline is a 50-character sentence now rather than
            three short adjectives, and `csf-headline` balances the lines within whatever
            measure it gets. */}
        <h1 className="csf-headline" style={{ margin: "0 auto", maxWidth: "26ch" }}>
          {HERO.words.map((w, i) => (
            // `as="span"` — these reveals sit inside the <h1>, which only accepts phrasing
            // content. Upstream's <div> is fine in a preview, not in server-rendered markup.
            // Key is index-qualified: a sentence can repeat a word, three adjectives couldn't.
            <Fragment key={`${w}-${i}`}>
              {/* A REAL space between words, not the `margin-right` upstream used. The margin
                  looks identical and is a lie: it leaves the h1's text content as one run-on
                  string, so screen readers announce a single nonsense word and copy-paste
                  produces one too. Survivable when the words were "Private." "Simple.", not
                  when they're a sentence. The space also supplies the gap, so the margin goes. */}
              {i > 0 ? " " : null}
              <Reveal
                as="span"
                delay={Math.round(i * step)}
                y={12}
                style={{ display: "inline-block" }}
              >
                {w}
              </Reveal>
            </Fragment>
          ))}
        </h1>
        <Reveal delay={420}>
          <p className="csf-lead" style={{ margin: "22px auto 0", maxWidth: "44ch" }}>
            {HERO.lead}
          </p>
        </Reveal>
        <Reveal delay={540}>
          {/* Note sits UNDER the CTA, not beside it: "Free to start" is a condition on the
              button, so it reads as a caption rather than a second, competing element. */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
              marginTop: 32,
            }}
          >
            <Button variant="primary" size="lg" icon="download" href={DOWNLOAD_START_PATH}>
              {HERO.cta}
            </Button>
            <span style={{ font: "400 14px/1.4 var(--font-ui)", color: "var(--text-tertiary)" }}>
              {HERO.note}
            </span>
          </div>
        </Reveal>
        <Reveal delay={300} y={28} className="cs-hero-stage">
          <MediaFrame
            icon="play_circle"
            label="Hero demo — app screenshot or video still"
          />
        </Reveal>
      </div>
    </section>
  );
}
