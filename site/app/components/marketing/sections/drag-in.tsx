/*
 * Section — Drag in: media left, copy right (the reversed how-it-works split).
 * Ported from `Claude design · v4-sections.jsx` → `SectionV4DragIn`:
 * `csInjectStyle` → a co-located stylesheet, `<image-slot>` → the drag-and-drop still.
 * Replaces the old four-step `SectionHowList` — upstream cut the numbered steps down
 * to this single "just drag it in" statement.
 */
import "./drag-in.css";
import { Reveal } from "~/lib/marketing/motion";
import { HOW } from "~/lib/marketing/content";

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
            {/* Sized by its own intrinsic ratio (see drag-in.css) — a screenshot of an app
                window is not croppable without cutting the window edge off. */}
            <img
              className="cs-dragin__img"
              src="/media/drag-and-drop-still.webp"
              width={1600}
              height={904}
              alt="Two photos being dragged from a Finder window onto the ColdStorage file list, which is highlighted to receive them."
              loading="lazy"
              decoding="async"
            />
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
