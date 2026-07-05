/*
 * DS · KeyValueRow — reimplemented from the compiled DS bundle's API. A labelled
 * commitment row: leading icon · label (left) · value (right), hairline-divided.
 */
import "./key-value-row.css";

export type KeyValueRowProps = {
  label: string;
  value: string;
  /** Material Symbols Rounded glyph name */
  icon: string;
};

export function KeyValueRow({ label, value, icon }: KeyValueRowProps) {
  return (
    <div className="csf-kvrow">
      <span className="csf-icon csf-kvrow__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="csf-kvrow__label">{label}</span>
      <span className="csf-kvrow__value">{value}</span>
    </div>
  );
}
