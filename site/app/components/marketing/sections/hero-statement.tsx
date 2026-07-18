/*
 * Section — Hero · statement: three revealed words over a wide media stage.
 * Ported from `design-mirror/marketing/v4-sections.jsx` → `SectionV4Hero`:
 * IIFE/`window` globals → imports, `csInjectStyle` → a co-located stylesheet,
 * `<image-slot>` → <MediaFrame> (see SPEC "Open decisions" — media pending).
 * Structure + inline styles kept faithful so re-pulls stay a clean diff.
 */
import "./hero-statement.css";
import { Reveal } from "~/lib/marketing/motion";
import { DOWNLOAD_START_PATH } from "~/lib/marketing/download";
import { HERO } from "~/lib/marketing/content";
import { Button } from "~/components/ds/button";
import { MediaFrame } from "~/components/marketing/shared/media-frame";

export function SectionHeroStatement() {
  return (
    <section className="csf-band" data-screen-label="Hero" style={{ paddingTop: 72 }}>
      <div className="csf-container" style={{ textAlign: "center" }}>
        <h1 className="csf-headline" style={{ margin: "0 auto", maxWidth: "22ch" }}>
          {HERO.words.map((w, i) => (
            // `as="span"` — these reveals sit inside the <h1>, which only accepts phrasing
            // content. Upstream's <div> is fine in a preview, not in server-rendered markup.
            <Reveal
              key={w}
              as="span"
              delay={i * 140}
              y={12}
              style={{ display: "inline-block", marginRight: "0.28em" }}
            >
              {w}
            </Reveal>
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
