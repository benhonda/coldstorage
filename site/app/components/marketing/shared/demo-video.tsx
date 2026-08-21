/*
 * Marketing · DemoVideo — a silent, looping screen recording of the real app.
 *
 * Replaces the `<MediaFrame>` placeholder that stood in for upstream's empty `<image-slot>`
 * drop zones. The clip has no audio track at all (stripped on encode), so it can autoplay
 * everywhere without the muted-autoplay caveats — and there is nothing for a caption track
 * to carry. It is a moving screenshot: the surrounding copy says what it shows, so it is
 * labelled rather than described.
 *
 * Reduced motion is honoured for real, not just declared: `prefers-reduced-motion` stops the
 * loop, rewinds to the poster frame and hands the user controls, so the demo is still
 * *watchable* on request instead of silently disappearing (PILLAR5 — no invisible content).
 */
import * as React from "react";
import "./demo-video.css";
import { useReducedMotion } from "~/lib/marketing/motion";

export type DemoVideoProps = {
  /** Path under `public/` — an H.264 MP4, audio stripped, `+faststart`. */
  src: string;
  /** First-frame still: what shows before playback, and the whole story under reduced motion. */
  poster: string;
  /** Announced name for the clip. Not marketing copy — it says what the video is. */
  label: string;
  className?: string;
};

export function DemoVideo({ src, poster, label, className }: DemoVideoProps) {
  const reduced = useReducedMotion();
  const ref = React.useRef<HTMLVideoElement | null>(null);

  // The attributes below are the *initial* state; flipping `autoplay`/`loop` on an element
  // that is already playing does nothing on its own, so stop it here when the preference
  // resolves (it reads false during SSR and first paint, then true if the user asked).
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Belt and braces: React sets `muted` as a property, and a hydrated <video> has been known
    // to come back with it unset — which is the difference between an autoplaying demo and a
    // blocked, permanently frozen poster.
    el.muted = true;
    if (!reduced) return;
    el.pause();
    el.currentTime = 0;
  }, [reduced]);

  return (
    <video
      ref={ref}
      className={className ? `cs-demo-video ${className}` : "cs-demo-video"}
      src={src}
      poster={poster}
      aria-label={label}
      autoPlay
      loop
      muted
      playsInline
      preload="metadata"
      controls={reduced}
    />
  );
}
