/*
 * Section — Hero · statement: the headline over a wide media stage.
 *
 * Originally `Claude design · v4-sections.jsx` → `SectionV4Hero`: IIFE/`window` globals →
 * imports, `csInjectStyle` → a co-located stylesheet, `<image-slot>` → the real thing: a silent
 * looping screen recording of files being dragged into the app.
 *
 * The headline has moved on from upstream's three separately-revealed adjectives: it is one
 * sentence now, revealed as a unit, with a single accented noun. Copy is `HERO.headline` in
 * content.ts, split into before/accent/after so the colour break is a content decision rather
 * than a substring match in here.
 */
import "./hero-statement.css";
import { Reveal } from "~/lib/marketing/motion";
import { DOWNLOAD_PATH } from "~/lib/marketing/download";
import { HERO } from "~/lib/marketing/content";
import { Button } from "~/components/ds/button";
import { DemoVideo } from "~/components/marketing/shared/demo-video";

export function SectionHeroStatement() {
  return (
    <section className="csf-band" data-screen-label="Hero" style={{ paddingTop: 72 }}>
      <div className="csf-container" style={{ textAlign: "center" }}>
        {/*
          The headline arrives as ONE unit, not word by word. The per-word stagger was right when
          the line was three standalone adjectives ("Private." "Cost-effective." "Simple.") — each
          word was its own beat. Now there's a noun cycling inside the sentence, and a word-by-word
          entrance underneath a rotating word is two animations competing for the same line: the
          eye can't tell which movement is the effect and which is the arrival. So the line reveals
          once, then the slot takes over as the only thing moving.

          26ch measure: the headline is a sentence now rather than three short words, and
          `csf-headline` balances the lines within whatever measure it gets.
        */}
        <Reveal y={12}>
          <h1 className="csf-headline" style={{ margin: "0 auto", maxWidth: "26ch" }}>
            {HERO.headline.before} <span className="cs-hero-accent">{HERO.headline.accent}</span>{" "}
            {HERO.headline.after}
          </h1>
        </Reveal>
        <Reveal delay={420}>
          <p className="csf-lead cs-hero-lead">{HERO.lead}</p>
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
            <Button variant="primary" size="lg" icon="download" href={DOWNLOAD_PATH}>
              {HERO.cta}
            </Button>
            <span style={{ font: "400 14px/1.4 var(--font-ui)", color: "var(--text-tertiary)" }}>
              {HERO.note}
            </span>
          </div>
        </Reveal>
        <Reveal delay={300} y={28} className="cs-hero-stage">
          <DemoVideo
            src="/media/hero-drag-and-drop.mp4"
            poster="/media/hero-drag-and-drop-poster.webp"
            label="ColdStorage on a Mac: files dragged from Finder into the app, uploading as they land."
          />
        </Reveal>
      </div>
    </section>
  );
}
