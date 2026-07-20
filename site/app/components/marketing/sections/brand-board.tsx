/*
 * Section · BrandBoard — the specimen grid on `/brand`.
 *
 * Imported from the "Coldstorage Brand Board" design (2026-07-20) and translated per
 * site/SPEC.md: the upstream board is a flat run of inline-styled divs with hard-coded hexes
 * and `<img>` tags pointing at the two logo SVGs. Three things changed on the way in.
 *
 *  1. **The mark is <BrandMark />, not an <img>.** Upstream ships two SVG files and swaps the
 *     src; we already have one component that carries the geometry once and flips the outline
 *     off the `.dark` class. So every dark specimen below is simply a tile with `className="dark"`
 *     — the correct cut falls out of the existing theming rather than a second asset.
 *  2. **Surfaces come from DS tokens**, not the board's literal `#FFFFFF` / `rgba(18,50,74,.08)`.
 *     The board was authored against the same token snapshot, so this is a rename, not a redesign.
 *     The one deliberate exception is the dark ground: the DS is light-only and defines no dark
 *     surface, so the vault gradient is declared locally in brand-board.css and marked as such.
 *  3. **Palette swatches read from `brand-palette.ts`** — the constants the mark actually paints
 *     with — instead of the board's copied hex strings. A brand page that can disagree with the
 *     brand is worse than no brand page.
 *
 * Upstream's copy was dropped on the floor (it is preview fixture text); the words come from
 * `BRAND_PAGE` in content.ts, per Layer D.
 */
import "./brand-board.css";
import { BrandMark } from "~/components/ds/brand-mark";
import { Wordmark } from "~/components/ds/wordmark";
import { BRAND_MARK_PALETTE, BRAND_COLOR_ORDER } from "~/lib/brand/brand-palette";
import { BRAND_PAGE } from "~/lib/marketing/content";

/** A specimen card: heading, the demo itself, and the construction note underneath. */
function Card({
  heading,
  note,
  wide,
  children,
}: {
  heading: string;
  note: string;
  /** Spans two columns — for specimens that need the width to read (lockups, icon, palette). */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`cs-brand__card${wide ? " cs-brand__card--wide" : ""}`}>
      <h2 className="cs-brand__card-h">{heading}</h2>
      <div className="cs-brand__demo">{children}</div>
      <p className="cs-brand__note">{note}</p>
    </section>
  );
}

/**
 * One specimen ground. `tone="dark"` puts the `.dark` class on the tile, which is what flips
 * `BrandMark` to its dark cut — see brand-mark.css.
 */
function Ground({
  tone,
  label,
  children,
}: {
  tone: "light" | "dark";
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`cs-brand__ground cs-brand__ground--${tone}${tone === "dark" ? " dark" : ""}`}>
      <div className="cs-brand__ground-body">{children}</div>
      <span className="cs-brand__ground-label">{label}</span>
    </div>
  );
}

export function BrandBoard() {
  const { specimens, grounds, swatches, iconScales } = BRAND_PAGE;

  /** Both grounds, side by side — the shape every specimen except the icon and palette takes. */
  const pair = (render: (tone: "light" | "dark") => React.ReactNode) => (
    <div className="cs-brand__pair">
      <Ground tone="light" label={grounds.light}>
        {render("light")}
      </Ground>
      <Ground tone="dark" label={grounds.dark}>
        {render("dark")}
      </Ground>
    </div>
  );

  return (
    <div className="csf-container cs-brand">
      <div className="cs-brand__grid">
        <Card heading={specimens.logomark.heading} note={specimens.logomark.note}>
          {pair(() => <BrandMark className="cs-brand__mark--lg" title="ColdStorage" />)}
        </Card>

        <Card heading={specimens.wordmark.heading} note={specimens.wordmark.note}>
          {pair(() => <Wordmark className="cs-brand__word--lg" />)}
        </Card>

        <Card
          heading={specimens.lockupHorizontal.heading}
          note={specimens.lockupHorizontal.note}
          wide
        >
          {pair(() => (
            <span className="cs-brand__lockup">
              <BrandMark className="cs-brand__mark--md" />
              <Wordmark className="cs-brand__word--md" />
            </span>
          ))}
        </Card>

        <Card heading={specimens.lockupStacked.heading} note={specimens.lockupStacked.note}>
          {pair(() => (
            <span className="cs-brand__lockup cs-brand__lockup--stacked">
              <BrandMark className="cs-brand__mark--md" />
              <Wordmark />
            </span>
          ))}
        </Card>

        <Card heading={specimens.appIcon.heading} note={specimens.appIcon.note} wide>
          <div className="cs-brand__icons">
            <figure className="cs-brand__icon-fig">
              {/* `dark` so the tile's mark takes the dark cut, matching the shipped .app icon. */}
              <span className="cs-brand__tile cs-brand__tile--lg dark">
                <BrandMark title="ColdStorage app icon" />
              </span>
              <figcaption className="cs-brand__ground-label">{iconScales.master}</figcaption>
            </figure>
            <figure className="cs-brand__icon-fig">
              <span className="cs-brand__tile cs-brand__tile--sm dark">
                <BrandMark />
              </span>
              <figcaption className="cs-brand__ground-label">{iconScales.home}</figcaption>
            </figure>
          </div>
        </Card>

        <Card heading={specimens.palette.heading} note={specimens.palette.note} wide>
          <ul className="cs-brand__swatches">
            {BRAND_COLOR_ORDER.map((key) => (
              <li key={key} className="cs-brand__swatch">
                <span
                  className="cs-brand__chip"
                  style={{ background: BRAND_MARK_PALETTE[key] }}
                  aria-hidden="true"
                />
                <code className="cs-brand__hex">{BRAND_MARK_PALETTE[key]}</code>
                <span className="cs-brand__role">{swatches[key]}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
