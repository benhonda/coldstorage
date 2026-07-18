/*
 * Marketing · MediaFrame — stands in for upstream's `<image-slot>` drop zones.
 *
 * The upstream Master leaves the hero and drag-in media areas as empty `<image-slot>`
 * elements ("Drop hero demo — app screenshot or video still"); design never filled them.
 * Rather than invent art here, we ship the frame at the exact aspect the design specifies,
 * so the composition, rhythm and responsive behaviour are all real — and swapping in the
 * finished asset later is a one-line change (`<MediaFrame>` → `<img>`/`<video>`).
 *
 * `label` is authoring intent, not marketing copy: it is aria-hidden and never announced.
 */
import "./media-frame.css";

export type MediaFrameProps = {
  /** What belongs here, for whoever produces the asset. Decorative — not read out. */
  label: string;
  /** Material Symbols Rounded glyph hinting at the intended content. */
  icon?: string;
};

export function MediaFrame({ label, icon = "photo_camera" }: MediaFrameProps) {
  return (
    // Decorative placeholder: presentational to assistive tech, since there is no real
    // content here yet and the surrounding copy already carries the section's meaning.
    <div className="cs-mediaframe" role="presentation">
      <div className="cs-mediaframe__inner" aria-hidden="true">
        <span className="csf-icon cs-mediaframe__icon">{icon}</span>
        <span className="cs-mediaframe__label">{label}</span>
      </div>
    </div>
  );
}
