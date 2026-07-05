/*
 * Shared marketing motion — calm, one-shot, scroll-driven. Ported from the upstream
 * design's `shared/motion.jsx` and made SSR-safe for React Router 7:
 *  - hooks default to the "no motion / visible" state on the server and first paint,
 *  - content is ALWAYS rendered (no-JS and SSR show it), reveal only hides not-yet-seen
 *    elements AFTER mount (below the fold, so there's no perceptible flash).
 * Only the helpers the shipped sections need are ported; add the rest with their sections.
 */
import * as React from "react";

export const CS_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

// useLayoutEffect warns during SSR; fall back to useEffect on the server.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

/** True when the user asked for reduced motion. SSR-safe: false until mounted. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Ref + "has it been seen once" flag. Fires open (true) if IO is unavailable. */
export function useInViewOnce(
  options?: IntersectionObserverInit
): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = React.useState(false);

  // Client-only, pre-paint: if the element is already in the viewport on mount, reveal it
  // synchronously so above-the-fold content never flashes hidden→visible.
  useIsomorphicLayoutEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.top < vh && r.bottom > 0) setSeen(true);
  }, [seen]);

  React.useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) {
      setSeen(true);
      return;
    }
    let gotCallback = false;
    const fallback = window.setTimeout(() => {
      if (!gotCallback) setSeen(true);
    }, 900);
    const io = new IntersectionObserver(
      (entries) => {
        gotCallback = true;
        window.clearTimeout(fallback);
        if (entries[0].isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      options ?? { threshold: 0.18, rootMargin: "0px 0px -48px 0px" }
    );
    io.observe(el);
    return () => {
      window.clearTimeout(fallback);
      io.disconnect();
    };
  }, [seen, options]);

  return [ref, seen];
}

type RevealProps = {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  threshold?: number;
  className?: string;
  style?: React.CSSProperties;
};

/** Fade-and-rise on first view. Visible pre-mount (SSR/no-JS) and under reduced motion. */
export function Reveal({ children, delay = 0, y = 16, threshold, className, style }: RevealProps) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = React.useState(false);
  const [ref, seen] = useInViewOnce(
    threshold != null ? { threshold, rootMargin: "0px 0px -48px 0px" } : undefined
  );
  React.useEffect(() => setMounted(true), []);

  // Hide only after mount, for not-yet-seen elements — those are below the fold, so
  // hiding them is imperceptible and lets them animate in on scroll.
  const hidden = mounted && !reduced && !seen;
  return (
    <div
      ref={ref}
      className={className}
      style={{
        ...style,
        opacity: hidden ? 0 : 1,
        transform: hidden ? `translateY(${y}px)` : "none",
        transition: reduced
          ? "none"
          : `opacity 650ms ${CS_EASE} ${delay}ms, transform 650ms ${CS_EASE} ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}
