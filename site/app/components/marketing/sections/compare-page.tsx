/*
 * Section · ComparePage — the whole of `/compare`: head, prose, the table, the honest
 * "which one you want" close, CTA.
 *
 * Its own renderer rather than a `ProsePage` variant because the table has to sit *between*
 * two prose runs, and that ordering is the argument (see the `blocksAfterTable` note in
 * content.ts). Bending `ProsePage` into accepting a mid-page slot would have made the shared
 * component worse to serve one page.
 *
 * Copy lives in `COMPARE_PAGE` in content.ts — read the page-specific constraints there before
 * touching any of it, especially the rule about never adding a competitor price that hasn't
 * been checked against that vendor's own pricing page.
 */
import "./compare-page.css";
import { PageHero } from "./page-hero";
import { Reveal } from "~/lib/marketing/motion";
import { DOWNLOAD_START_PATH } from "~/lib/marketing/download";
import { COMPARE_PAGE } from "~/lib/marketing/content";
import { Button } from "~/components/ds/button";
import type { ProseBlock } from "~/lib/marketing/content";

export function ComparePage() {
  const content = COMPARE_PAGE;

  return (
    <>
      <PageHero content={content} />

      {content.blocks.map((block, i) => (
        <ProseBand key={block.heading} block={block} tinted={i % 2 === 1} />
      ))}

      <section
        data-screen-label="Comparison table"
        className="csf-band"
        style={{ borderTop: "1px solid var(--border-subtle)" }}
      >
        <div className="csf-container">
          <div className="cs-compare">
            <Reveal y={16}>
              <div className="cs-compare__scroll">
                <table className="cs-compare__table">
                  <caption className="sr-only">
                    ColdStorage compared with instant-access cloud storage
                  </caption>
                  <thead>
                    <tr>
                      {/* Empty corner cell: the row labels below it are themselves headers. */}
                      <th scope="col">
                        <span className="sr-only">What's being compared</span>
                      </th>
                      <th scope="col" className="cs-compare__ours">
                        {content.table.ourHead}
                      </th>
                      <th scope="col">{content.table.theirHead}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {content.table.rows.map((row) => (
                      <tr key={row.label}>
                        <th scope="row">{row.label}</th>
                        <td className="cs-compare__ours">{row.ours}</td>
                        <td>{row.theirs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Reveal>
            <p className="cs-compare__note">{content.sourceNote}</p>
          </div>
        </div>
      </section>

      {content.blocksAfterTable.map((block) => (
        <ProseBand key={block.heading} block={block} tinted />
      ))}

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
              <Button variant="primary" size="lg" icon="download" href={DOWNLOAD_START_PATH}>
                {content.cta.label}
              </Button>
              <span style={{ font: "400 15px/1.4 var(--font-ui)", color: "var(--text-secondary)" }}>
                {content.cta.note}
              </span>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}

/** One headed prose band — same shape `ProsePage` uses, so the two pages read identically. */
function ProseBand({ block, tinted }: { block: ProseBlock; tinted: boolean }) {
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

/** Heading → anchor id, so each block is linkable. Mirrors `prose-page.tsx`. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
