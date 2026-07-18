/*
 * Section · Help center — the `/help` route: a head, then one band per topic group with the
 * group's questions in a DS Accordion, then a sign-off pointing at `/contact`.
 *
 * The groups render through the same `Accordion` the landing FAQ uses (that's why `HelpItem`
 * is an alias of `FaqItem` in content.ts) — one disclosure implementation, one set of
 * accessibility behaviors, and answers stay in the DOM for no-JS and for search engines.
 *
 * Copy is `HELP_PAGE` in content.ts. Note what it deliberately does NOT answer — see the
 * comment there before adding a question, because the gaps are gaps on purpose.
 *
 * The page head is not here: `/help` renders the shared `<PageHero>` like every other
 * non-landing page. `SectionHelpHead` used to be a byte-for-byte copy of the prose pages' head.
 */
import "./help-center.css";
import { Reveal } from "~/lib/marketing/motion";
import { HELP_PAGE } from "~/lib/marketing/content";
import { Accordion } from "~/components/ds/accordion";
import { Button } from "~/components/ds/button";

export function SectionHelpGroups() {
  return (
    <>
      {HELP_PAGE.groups.map((group, i) => (
        <section
          key={group.heading}
          id={slugify(group.heading)}
          className="csf-band"
          data-screen-label={group.heading}
          style={{
            borderTop: "1px solid var(--border-subtle)",
            ...(i % 2 === 1 ? { background: "var(--surface-raised)" } : {}),
          }}
        >
          <div className="csf-container">
            <div className="cs-help">
              <div className="cs-help__head">
                <h2 className="csf-title cs-help__h2">{group.heading}</h2>
              </div>
              <Reveal y={16}>
                <div className="cs-help__card">
                  {/* No `defaultOpen` — on a page of four groups, one pre-opened answer per
                      group is four open panels competing for the same attention. */}
                  <Accordion items={group.items} />
                </div>
              </Reveal>
            </div>
          </div>
        </section>
      ))}
    </>
  );
}

export function SectionHelpContact() {
  return (
    <section
      data-screen-label="Contact sign-off"
      style={{ background: "var(--accent-subtle)", borderTop: "1px solid var(--border-subtle)" }}
    >
      <div className="csf-container csf-band">
        <Reveal>
          <div className="cs-help__foot">
            <p className="cs-help__foot-text">{HELP_PAGE.footer.text}</p>
            <Button variant="primary" size="lg" icon="mail" href="/contact">
              {HELP_PAGE.footer.linkLabel}
            </Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** Heading → anchor id, so each group is linkable. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
