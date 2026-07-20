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
// `ProseBand` brings `prose-page.css` with it. Do not re-implement the prose markup here —
// see the note on `ProseBand` for what happens when you do.
import { ProseBand } from "./prose-page";
import { Reveal } from "~/lib/marketing/motion";
import { DOWNLOAD_START_PATH } from "~/lib/marketing/download";
import { COMPARE_PAGE } from "~/lib/marketing/content";
import { Button } from "~/components/ds/button";

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
            {/* The money table. Its own table rather than a row in the one below, because four
                vendors don't fit an ours-vs-theirs shape — and price is the row people came for. */}
            <Reveal y={16}>
              <div className="cs-compare__scroll">
                <table className="cs-compare__table cs-compare__table--prices">
                  <caption className="sr-only">
                    Cost of 2 TB a year, billed yearly, in US dollars
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{content.prices.heading}</th>
                      <th scope="col">Per year</th>
                      <th scope="col">Per month</th>
                    </tr>
                  </thead>
                  <tbody>
                    {content.prices.rows.map((row) => (
                      <tr key={row.vendor} className={row.ours ? "cs-compare__ours" : undefined}>
                        <th scope="row">{row.vendor}</th>
                        <td>{row.perYear}</td>
                        <td>{row.perMonth}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Reveal>

            <Reveal y={16}>
              <div className="cs-compare__scroll cs-compare__scroll--second">
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

