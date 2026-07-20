/*
 * Section · ProsePage — the shared renderer for every headed-prose route: `/how-it-works`,
 * `/about`, `/open-source`. Head, then one band per block, then the page's own CTA.
 *
 * Was `how-explainer.tsx`, which hardcoded `HOW_PAGE` and a download CTA. Three pages wanted
 * the same layout, so the content moved into a prop (`ProsePageContent` in content.ts) and the
 * CTA target became one too — `/open-source` sends people to GitHub, not to a download.
 *
 * No upstream design counterpart — assembled from existing DS primitives and the same `csf-*`
 * layout classes every ported section uses, so it sits in the system rather than inventing a
 * new visual language. Flagged for an upstream design pass (see SPEC "Open decisions").
 *
 * Read the constraints in content.ts before editing any of the copy this renders — notably
 * that `/how-it-works` carries no dollar figures and no page names the backend provider.
 *
 * The head is the shared `<PageHero>` (upstream `page-heroes.jsx`) — the same one every other
 * non-landing page wears. It used to be a local `ProseHead` that two other pages had each
 * copied verbatim.
 */
import "./prose-page.css";
import { PageHero } from "./page-hero";
import { Reveal } from "~/lib/marketing/motion";
import { DOWNLOAD_START_PATH } from "~/lib/marketing/download";
import type { ProseBlock, ProsePageContent } from "~/lib/marketing/content";
import { Button } from "~/components/ds/button";

export type ProsePageProps = {
  content: ProsePageContent;
  /**
   * Where the closing CTA points. Defaults to the auto-start download, which is right for
   * every page that's selling the app; `/open-source` overrides it with the repo URL.
   */
  ctaHref?: string;
  /** Leading glyph on the CTA button. `download` unless the CTA isn't a download. */
  ctaIcon?: string;
};

export function ProsePage({
  content,
  ctaHref = DOWNLOAD_START_PATH,
  ctaIcon = "download",
}: ProsePageProps) {
  return (
    <>
      <PageHero content={content} />
      <ProseBlocks content={content} />
      <ProseCta content={content} ctaHref={ctaHref} ctaIcon={ctaIcon} />
    </>
  );
}

/** The headed prose blocks, alternating tint so the page has some rhythm. */
function ProseBlocks({ content }: { content: ProsePageContent }) {
  return (
    <>
      {content.blocks.map((block, i) => (
        // Tint every other block rather than every block — a wall of cards reads busier than
        // plain prose, and these pages are prose.
        <ProseBand key={block.heading} block={block} tinted={i % 2 === 1} />
      ))}
    </>
  );
}

/**
 * One headed prose band: heading left (sticky), body right, on the `.cs-prose` grid.
 *
 * Exported because `/compare` interleaves prose with its comparison table and so can't use
 * `<ProsePage>` wholesale. It must be **imported**, never re-implemented — `/compare` originally
 * carried a copy of this markup, which silently lost every `.cs-prose*` rule (the styles live in
 * `prose-page.css`, imported at the top of this file). The result rendered at browser-default
 * size, full-bleed to the container, with no gap under the heading. Importing the component
 * carries its stylesheet with it; copying the JSX does not.
 */
export function ProseBand({ block, tinted = false }: { block: ProseBlock; tinted?: boolean }) {
  return (
    <section
      id={slugify(block.heading)}
      className="csf-band"
      data-screen-label={block.heading}
      style={{
        borderTop: "1px solid var(--border-subtle)",
        ...(tinted ? { background: "var(--surface-raised)" } : {}),
      }}
    >
      <div className="csf-container">
        <div className="cs-prose">
          <div className="cs-prose__head">
            <h2 className="csf-title cs-prose__h2">{block.heading}</h2>
          </div>
          <Reveal y={16}>
            <div className="cs-prose__body">
              {block.body.map((p) => (
                <p key={p} className="cs-prose__p">
                  {p}
                </p>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/** The page's own sign-off. */
function ProseCta({
  content,
  ctaHref,
  ctaIcon,
}: {
  content: ProsePageContent;
  ctaHref: string;
  ctaIcon: string;
}) {
  return (
    <section
      data-screen-label="Closing CTA"
      style={{ background: "var(--accent-subtle)", borderTop: "1px solid var(--border-subtle)" }}
    >
      <div className="csf-container csf-band" style={{ textAlign: "center" }}>
        <Reveal>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 20,
              flexWrap: "wrap",
            }}
          >
            <Button variant="primary" size="lg" icon={ctaIcon} href={ctaHref}>
              {content.cta.label}
            </Button>
            <span style={{ font: "400 15px/1.4 var(--font-ui)", color: "var(--text-secondary)" }}>
              {content.cta.note}
            </span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** Heading → anchor id, so each block is linkable. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
