/*
 * ArchNotice — warn-only Intel-Mac detection for the download page (the Screen Studio pattern:
 * detect when the browser allows it, say nothing when it doesn't, never block the button).
 *
 * The release ships arm64-only, so an Intel Mac downloads fine and then refuses to launch with
 * a bare OS alert. This surfaces that *before* the download — but only on a POSITIVE Intel
 * signal, because most Mac browsers hide the architecture on purpose:
 *
 *  - Safari/Firefox freeze the UA at "Intel Mac OS X 10_15_7" on every Mac → useless, and why
 *    UA sniffing is not attempted at all.
 *  - Chromium exposes the real answer via UA-CH high-entropy hints ("arm" | "x86") → trusted
 *    outright, both directions.
 *  - Failing that, the WebGL renderer string names the GPU vendor in most non-Safari browsers;
 *    an Intel/AMD/NVIDIA GPU on a Mac means an Intel Mac (Apple silicon GPUs are "Apple ...").
 *
 * Inconclusive (all of Safari) → render nothing and let the static requirements note in
 * `DOWNLOAD_PAGE.note` do its job. SSR renders nothing; detection runs in an effect.
 */
import "./arch-notice.css";
import { useEffect, useState } from "react";
import { DOWNLOAD_PAGE } from "~/lib/marketing/content";

/** UA-CH shapes — not in TS's DOM lib yet (Chromium-only API), so declared minimally here. */
type NavigatorUAData = {
  platform?: string;
  getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }>;
};

/** True only when this is a Mac (not an iPad masquerading as one). */
function isMac(): boolean {
  return /Mac/.test(navigator.platform) && navigator.maxTouchPoints <= 1;
}

/** Positive-signal-only: resolves true ONLY when the browser affirmatively reports Intel. */
async function detectIntelMac(): Promise<boolean> {
  if (!isMac()) return false;

  // 1) UA-CH (Chromium): the real answer when present — trust it both ways.
  const { userAgentData } = navigator as Navigator & { userAgentData?: NavigatorUAData };
  if (userAgentData) {
    try {
      const { architecture } = await userAgentData.getHighEntropyValues(["architecture"]);
      if (architecture) return architecture.startsWith("x86");
    } catch {
      // hint refused — fall through to the GPU heuristic
    }
  }

  // 2) WebGL renderer heuristic: an Intel/AMD/NVIDIA GPU on a Mac ⇒ Intel Mac. Apple silicon
  //    reports "Apple ..." (e.g. "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 ...)"), and
  //    Safari masks everything as "Apple GPU" — both fail the test, so Safari stays silent.
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return false;
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(
      debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    return /\b(Intel|AMD|Radeon|NVIDIA|GeForce)\b/i.test(renderer) && !/Apple/i.test(renderer);
  } catch {
    return false;
  }
}

/**
 * Detection as a hook, owned by the page so future consumers share one detection pass.
 *
 * `null` = still detecting / SSR. `true` = positively an Intel Mac. `false` = everything else
 * (Apple silicon, non-Mac, or a browser that hides the answer).
 */
export function useIntelMacDetection(): boolean | null {
  const [isIntelMac, setIsIntelMac] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    detectIntelMac().then((intel) => {
      if (!cancelled) setIsIntelMac(intel);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return isIntelMac;
}

export function ArchNotice({ isIntelMac }: { isIntelMac: boolean | null }) {
  if (!isIntelMac) return null;
  return (
    <p className="csf-arch-notice" role="status">
      {DOWNLOAD_PAGE.intelNotice}
    </p>
  );
}
