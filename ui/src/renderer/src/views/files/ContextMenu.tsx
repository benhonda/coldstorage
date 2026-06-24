/**
 * Right-click context menu — a cursor-anchored popover of actions. Closes on any outside click, a
 * second right-click, or Escape. Items run their action then close; `"separator"` groups them.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../ui/primitives.tsx";

export interface MenuItem {
  label: string;
  icon: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export type MenuEntry = MenuItem | "separator";

/** Gap kept between the menu and any viewport edge. */
const MARGIN = 8;

export const ContextMenu = ({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);
  // Start at the requested point; clamp into the viewport once we can measure the rendered size.
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    // Prefer opening at the cursor; if it would overflow an edge, shift back so it stays fully visible
    // (and never past the top/left). Runs before paint, so there's no flash at the wrong spot.
    const maxLeft = window.innerWidth - width - MARGIN;
    const maxTop = window.innerHeight - height - MARGIN;
    setPos({
      left: Math.max(MARGIN, Math.min(x, maxLeft)),
      top: Math.max(MARGIN, Math.min(y, maxTop)),
    });
  }, [x, y, items]);

  useEffect(() => {
    const close = (): void => onClose();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    // `click`/`contextmenu` on window dismiss; the panel stops propagation so its own clicks don't.
    // `resize`/`scroll` close too — a stale anchor is worse than reopening.
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="cs-menu" style={{ left: pos.left, top: pos.top }} onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it === "separator" ? (
          <div key={`sep-${i}`} className="cs-menu-sep" />
        ) : (
          <button
            key={it.label}
            type="button"
            className={it.danger ? "cs-menu-item cs-menu-item--danger" : "cs-menu-item"}
            disabled={it.disabled}
            onClick={() => {
              it.onClick();
              onClose();
            }}
          >
            <Icon name={it.icon} size={20} />
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
};
