/*
 * Shared — simplified macOS Tahoe (Liquid Glass) window chrome. Ported VERBATIM from
 * `Claude design · shared/macos-window.jsx`: the `window`-globals became named
 * exports and the loose scaffold props got light types. Raw hex/px are intentional
 * (@ds-adherence-ignore upstream) — this is a rendered mock, not product UI. No assets,
 * no deps. SSR-safe (pure render, no browser globals at module scope).
 */
import * as React from "react";

const MAC_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro", "Helvetica Neue", sans-serif';

// ─────────────────────────────────────────────────────────────
// Liquid glass primitive — blur + white tint + inset highlight
// ─────────────────────────────────────────────────────────────
export function MacGlass({
  children,
  radius = 296,
  dark = false,
  style = {},
}: {
  children?: React.ReactNode;
  radius?: number;
  dark?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ position: "relative", borderRadius: radius, ...style }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: radius,
          background: dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.35)",
          backdropFilter: "blur(40px) saturate(180%)",
          WebkitBackdropFilter: "blur(40px) saturate(180%)",
          border: dark
            ? "0.5px solid rgba(255,255,255,0.12)"
            : "0.5px solid rgba(255,255,255,0.6)",
          boxShadow: dark
            ? "0 8px 40px rgba(0,0,0,0.2)"
            : "0 8px 40px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.4)",
        }}
      />
      <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Traffic lights (14px, Tahoe colors)
// ─────────────────────────────────────────────────────────────
export function MacTrafficLights({ style = {} }: { style?: React.CSSProperties }) {
  const dot = (bg: string) => (
    <div
      style={{
        width: 14,
        height: 14,
        borderRadius: "50%",
        background: bg,
        border: "0.5px solid rgba(0,0,0,0.1)",
      }}
    />
  );
  return (
    <div style={{ display: "flex", gap: 9, alignItems: "center", padding: 1, ...style }}>
      {dot("#ff736a")}
      {dot("#febc2e")}
      {dot("#19c332")}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Toolbar — title + single glass pill icon
// ─────────────────────────────────────────────────────────────
export function MacToolbar({ title = "Folder" }: { title?: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: 8,
        flexShrink: 0,
      }}
    >
      {/* title */}
      <div
        style={{
          fontFamily: MAC_FONT,
          fontSize: 15,
          fontWeight: 700,
          color: "rgba(0,0,0,0.85)",
          whiteSpace: "nowrap",
          paddingLeft: 8,
        }}
      >
        {title}
      </div>
      <div style={{ flex: 1 }} />
      {/* single action */}
      <MacGlass>
        <div
          style={{
            width: 36,
            height: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: "#4c4c4c",
              opacity: 0.4,
            }}
          />
        </div>
      </MacGlass>
      {/* search */}
      <MacGlass>
        <div
          style={{
            width: 140,
            height: 36,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 12px",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <circle cx="5.5" cy="5.5" r="4" stroke="#727272" strokeWidth="1.5" />
            <path d="M8.5 8.5l3 3" stroke="#727272" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span
            style={{
              fontFamily: MAC_FONT,
              fontSize: 13,
              fontWeight: 500,
              color: "#727272",
            }}
          >
            Search
          </span>
        </div>
      </MacGlass>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Sidebar — frosted glass panel floating inside the window
// ─────────────────────────────────────────────────────────────
export function MacSidebarItem({
  label,
  selected = false,
}: {
  label: string;
  selected?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: "4px 10px 4px 6px",
        margin: "0 10px",
        borderRadius: 8,
        position: "relative",
        fontFamily: MAC_FONT,
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      {selected && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 8,
            background: "rgba(0,0,0,0.11)",
            mixBlendMode: "multiply",
          }}
        />
      )}
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: selected ? "#007aff" : "rgba(0,0,0,0.4)",
          opacity: selected ? 1 : 0.5,
          flexShrink: 0,
          position: "relative",
        }}
      />
      <span style={{ color: "rgba(0,0,0,0.85)", position: "relative" }}>{label}</span>
    </div>
  );
}

export function MacSidebar({ children }: { children?: React.ReactNode }) {
  return (
    <div
      style={{
        width: 220,
        height: "100%",
        padding: 8,
        flexShrink: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* glass panel */}
      <div
        style={{
          position: "absolute",
          inset: 8,
          borderRadius: 18,
          background: "rgba(210,225,245,0.45)",
          backdropFilter: "blur(50px) saturate(200%)",
          WebkitBackdropFilter: "blur(50px) saturate(200%)",
          border: "0.5px solid rgba(255,255,255,0.5)",
          boxShadow: "0 8px 40px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.35)",
        }}
      />
      {/* content */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "10px 0",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {/* window controls + sidebar toggle */}
        <div
          style={{
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 10px",
            marginBottom: 4,
          }}
        >
          <MacTrafficLights />
        </div>
        {children}
      </div>
    </div>
  );
}

export function MacSidebarHeader({ title }: { title: string }) {
  return (
    <div
      style={{
        padding: "14px 18px 5px",
        fontFamily: MAC_FONT,
        fontSize: 11,
        fontWeight: 700,
        color: "rgba(0,0,0,0.5)",
      }}
    >
      {title}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Window — r:26, big shadow, sidebar + toolbar + content
// ─────────────────────────────────────────────────────────────
export function MacWindow({
  width = 900,
  height = 600,
  title = "Folder",
  sidebar,
  children,
}: {
  width?: number;
  height?: number;
  title?: string;
  sidebar?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 26,
        overflow: "hidden",
        background: "#fff",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.23), 0 16px 48px rgba(0,0,0,0.35)",
        display: "flex",
        position: "relative",
        fontFamily: MAC_FONT,
      }}
    >
      <MacSidebar>{sidebar}</MacSidebar>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <MacToolbar title={title} />
        <div style={{ flex: 1, overflow: "auto", padding: "4px 8px" }}>{children}</div>
      </div>
    </div>
  );
}
