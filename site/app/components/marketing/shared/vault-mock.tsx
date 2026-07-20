/*
 * Shared — the animated "vault" Mac-app mock (proof-of-safety UI) used by the app-mock
 * hero. Ported from `Claude design · shared/vault-mock.jsx`: `window`-globals →
 * ES imports, `React.useLayoutEffect` → the isomorphic pattern from motion.tsx (SSR-safe),
 * `React.Fragment` → `<>`. Depends on mac-window.tsx (MacWindow, MacSidebarHeader) and the
 * DS Badge/Button. Structure + inline styles kept faithful so re-pulls stay a clean diff.
 */
import * as React from "react";
import { CS_EASE, useReducedMotion, useInViewOnce } from "~/lib/marketing/motion";
import { Badge } from "~/components/ds/badge";
import { Button } from "~/components/ds/button";
import { MacWindow, MacSidebarHeader } from "./mac-window";

// useLayoutEffect warns during SSR; fall back to useEffect on the server.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

const CSC_TINTS = [
  "color-mix(in oklab, var(--hue-blue) 22%, #EAF2F8)",
  "color-mix(in oklab, var(--hue-cyan) 20%, #EAF4F6)",
  "color-mix(in oklab, var(--hue-blue) 34%, #DFEBF4)",
  "color-mix(in oklab, var(--hue-green) 16%, #ECF4EE)",
  "color-mix(in oklab, var(--hue-violet) 14%, #EFF0F8)",
  "color-mix(in oklab, var(--hue-cyan) 30%, #E2F0F2)",
  "color-mix(in oklab, var(--hue-amber) 14%, #F6F2EA)",
  "color-mix(in oklab, var(--hue-blue) 14%, #EDF3F8)",
];

type Phase = "idle" | "run" | "done";

function ThumbGrid({
  count,
  cols,
  size = "1 / 1",
  radius = 10,
  seed = 0,
  shown = true,
  stagger = 0,
}: {
  count: number;
  cols: number;
  size?: string;
  radius?: number;
  seed?: number;
  shown?: boolean;
  stagger?: number;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            aspectRatio: size,
            borderRadius: radius,
            background: CSC_TINTS[(i * 3 + seed) % CSC_TINTS.length],
            opacity: shown ? 1 : 0,
            transform: shown ? "none" : "scale(0.72)",
            transition: `opacity 420ms ${CS_EASE} ${i * stagger}ms, transform 420ms ${CS_EASE} ${i * stagger}ms`,
          }}
        ></div>
      ))}
    </div>
  );
}

function SourceRow({
  icon,
  label,
  status,
  tone,
}: {
  icon: string;
  label: string;
  status: string;
  tone?: "warn";
}) {
  const dotColor = tone === "warn" ? "var(--hue-amber)" : "var(--positive)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "24px 1fr",
        gap: 8,
        alignItems: "start",
        padding: "7px 10px",
        margin: "0 10px",
        borderRadius: 8,
      }}
    >
      <span className="csf-icon" style={{ fontSize: 17, color: "rgba(0,0,0,0.5)", marginTop: 1 }}>
        {icon}
      </span>
      <div>
        <div style={{ font: "500 12.5px/1.3 var(--font-ui)", color: "rgba(0,0,0,0.85)" }}>
          {label}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
          <span
            style={{ width: 6, height: 6, borderRadius: 999, background: dotColor, flexShrink: 0 }}
          ></span>
          <span style={{ font: "400 11px/1.3 var(--font-ui)", color: "rgba(0,0,0,0.5)" }}>
            {status}
          </span>
        </div>
      </div>
    </div>
  );
}

function VaultSidebar() {
  return (
    <>
      <MacSidebarHeader title="Sources" />
      <SourceRow icon="photo_library" label="Photos library" status="Archived 2 hr ago" />
      <SourceRow icon="folder" label="Documents" status="Archived yesterday" />
      <SourceRow icon="laptop_mac" label="Old MacBook" status="Paused since Jun 12" tone="warn" />
      <MacSidebarHeader title="Storage" />
      <div style={{ padding: "4px 20px 8px" }}>
        <div className="csf-mono" style={{ font: "500 11px/1 var(--font-mono)", color: "rgba(0,0,0,0.6)" }}>
          148 GB of 500 GB
        </div>
        <div style={{ marginTop: 7, height: 4, borderRadius: 999, background: "rgba(0,0,0,0.08)" }}>
          <div style={{ width: "30%", height: "100%", borderRadius: 999, background: "var(--accent)" }}></div>
        </div>
      </div>
    </>
  );
}

function VaultContent({ phase }: { phase: Phase }) {
  const catching = phase !== "done";
  return (
    <div style={{ padding: "8px 16px 16px", fontFamily: "var(--font-ui)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          background: "var(--surface-raised)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 14,
          padding: "12px 16px",
        }}
      >
        {catching ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Badge tone="accent" icon="cloud_upload">
              catching up
            </Badge>
            <span style={{ font: "500 14px/1.3 var(--font-ui)", color: "var(--text-primary)" }}>
              Archiving newest first — 96 of 148 GB
            </span>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Badge tone="success" icon="check">
              safe
            </Badge>
            <span style={{ font: "500 14px/1.3 var(--font-ui)", color: "var(--text-primary)" }}>
              Your last 30 days are safe ✓
            </span>
          </div>
        )}
        <span className="csf-mono" style={{ font: "400 12px/1 var(--font-mono)", color: "var(--text-tertiary)" }}>
          {catching ? "3,412 of 5,167 items" : "148 GB archived · verified just now"}
        </span>
      </div>
      <div style={{ margin: "16px 2px 8px", font: "600 13px/1 var(--font-ui)", color: "var(--text-secondary)" }}>
        November
      </div>
      <ThumbGrid count={14} cols={7} shown={phase !== "idle"} stagger={phase === "run" ? 90 : 0} />
      <div style={{ margin: "16px 2px 8px", font: "600 13px/1 var(--font-ui)", color: "var(--text-secondary)" }}>
        October
      </div>
      <ThumbGrid count={7} cols={7} seed={4} />
    </div>
  );
}

/* Scales the fixed-size window to its container width, and plays the
   catch-up sequence once when scrolled into view. */
export function MacMock() {
  const W = 1020;
  const H = 620;
  const measureRef = React.useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = React.useState({ scale: 1, offset: 0 });
  const reduced = useReducedMotion();
  const [phase, setPhase] = React.useState<Phase>(reduced ? "done" : "idle");
  const [viewRef, seen] = useInViewOnce({ threshold: 0.3 });
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useIsomorphicLayoutEffect(() => {
    const measure = () => {
      if (!measureRef.current) return;
      const cw = measureRef.current.clientWidth;
      const s = Math.min(1, cw / W);
      // Anchor the scale to the container's left edge and center with an
      // explicit offset: with a layout box wider than its container,
      // margin auto + origin "top center" left-anchors the box and pushes
      // the scaled visual off-center (horizontal scrollbar on narrow views).
      setFit({ scale: s, offset: Math.max(0, (cw - W * s) / 2) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      clearTimeout(timer.current);
    };
  }, []);

  const start = React.useCallback(() => {
    setPhase("run");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPhase("done"), 14 * 90 + 800);
  }, []);

  React.useEffect(() => {
    if (reduced) {
      setPhase("done");
      return;
    }
    if (seen) start();
  }, [seen, reduced, start]);

  const replay = () => {
    if (reduced) return;
    setPhase("idle");
    requestAnimationFrame(() => requestAnimationFrame(start));
  };

  return (
    <div ref={viewRef}>
      <div ref={measureRef} style={{ width: "100%", height: H * fit.scale }}>
        <div
          style={{
            transform: `scale(${fit.scale})`,
            transformOrigin: "top left",
            width: W,
            marginLeft: fit.offset,
          }}
        >
          <MacWindow width={W} height={H} title="ColdStorage" sidebar={<VaultSidebar />}>
            <VaultContent phase={phase} />
          </MacWindow>
        </div>
      </div>
      {!reduced && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginTop: 18,
            opacity: phase === "done" ? 1 : 0,
            transition: `opacity 300ms ${CS_EASE}`,
            pointerEvents: phase === "done" ? "auto" : "none",
          }}
        >
          <Button variant="ghost" size="sm" icon="replay" onClick={replay}>
            Replay
          </Button>
        </div>
      )}
    </div>
  );
}
