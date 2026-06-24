/**
 * A horizontal drag-to-resize hook (e.g. the sidebar). Returns the current width and a pointer-down
 * handler for the drag handle; the width is clamped to [min, max] and persisted to localStorage so the
 * user's choice survives restarts. The drag captures the start width at pointer-down (fixed for the
 * gesture) and tracks pointer movement on window until release.
 */
import { useCallback, useEffect, useState } from "react";

export const useResizable = (
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number,
): { width: number; onResizeStart: (e: React.PointerEvent) => void } => {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : defaultWidth;
  });

  useEffect(() => {
    localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  const onResizeStart = useCallback(
    (e: React.PointerEvent): void => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width; // fixed for this drag
      const onMove = (ev: PointerEvent): void => {
        setWidth(Math.min(max, Math.max(min, startW + (ev.clientX - startX))));
      };
      const onUp = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, min, max],
  );

  return { width, onResizeStart };
};
