/*
 * Section — Hero · app mock: centered statement over the animated Mac vault window.
 * Ported from `design-mirror/marketing/hero-app-mock.jsx`: IIFE/`window` global → named
 * export, shared globals → imports. Structure + inline styles kept faithful to upstream.
 */
import { Reveal } from "~/lib/marketing/motion";
import { csScrollTo } from "~/lib/marketing/site";
import { DOWNLOAD_PATH } from "~/lib/marketing/download";
import { Button } from "~/components/ds/button";
import { MacMock } from "~/components/marketing/shared/vault-mock";

export function SectionHeroAppMock() {
  return (
    <section
      className="csf-band csf-band--lg"
      data-screen-label="Hero — Point it and walk away"
      style={{ paddingBottom: "var(--section-y)" }}
    >
      <div className="csf-container" style={{ textAlign: "center" }}>
        <Reveal y={12}>
          <span className="csf-eyebrow">ColdStorage for Mac</span>
        </Reveal>
        <Reveal delay={90} y={20}>
          <h1 className="cs-hero-title" style={{ maxWidth: "20ch", margin: "0 auto" }}>
            Point it at your photos and walk away.
          </h1>
        </Reveal>
        <Reveal delay={220}>
          <p className="csf-lead" style={{ margin: "22px auto 0", maxWidth: "54ch" }}>
            ColdStorage archives your Photos library and the folders you'd hate to lose —
            encrypted on your Mac, kept somewhere else entirely, and shown to you plainly so
            you can see it worked.
          </p>
        </Reveal>
        <Reveal delay={340}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              flexWrap: "wrap",
              marginTop: 32,
            }}
          >
            <Button variant="primary" size="lg" icon="download" href={DOWNLOAD_PATH}>
              Download for Mac
            </Button>
            <Button variant="ghost" size="lg" onClick={() => csScrollTo("how")}>
              How it works
            </Button>
          </div>
          <p style={{ margin: "14px 0 0", font: "400 14px/1.5 var(--font-ui)", color: "var(--text-tertiary)" }}>
            Free app · storage from <span className="csf-mono">$9.99</span> a year —{" "}
            <span className="csf-mono">$0.83</span> a month
          </p>
        </Reveal>
        <Reveal delay={430} y={26}>
          <div style={{ marginTop: "clamp(36px, 5vw, 64px)" }}>
            <MacMock />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
