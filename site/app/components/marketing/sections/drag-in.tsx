/*
 * Section — Drag in: media left, copy right (the reversed how-it-works split).
 * Ported from `design-mirror/marketing/v4-sections.jsx` → `SectionV4DragIn`:
 * `csInjectStyle` → a co-located stylesheet, `<image-slot>` → <MediaFrame>.
 * Replaces the old four-step `SectionHowList` — upstream cut the numbered steps down
 * to this single "just drag it in" statement.
 */
import "./drag-in.css";
import { Reveal } from "~/lib/marketing/motion";
import { HOW } from "~/lib/marketing/content";
import { MediaFrame } from "~/components/marketing/shared/media-frame";

export function SectionDragIn() {
  return (
    <section
      id="how"
      className="csf-band"
      data-screen-label="Drag in"
      style={{ borderTop: "1px solid var(--border-subtle)" }}
    >
      <div className="csf-container">
        <div className="cs-dragin">
          <Reveal y={20} className="cs-dragin__media">
            <MediaFrame icon="drag_pan" label="Drag-in demo still" />
          </Reveal>
          <div>
            <span className="csf-eyebrow">{HOW.eyebrow}</span>
            <h2 className="csf-title">{HOW.title}</h2>
            <p className="csf-lead" style={{ marginTop: 14, fontSize: "var(--text-lg)" }}>
              {HOW.body}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
