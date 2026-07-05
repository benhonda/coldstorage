/* Shared motion utilities — calm, one-shot, scroll-driven. No loops, no springs.
   All gated on prefers-reduced-motion. */

const CS_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

function useReducedMotion() {
  const [reduced, setReduced] = React.useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function useInViewOnce(options) {
  const ref = React.useRef(null);
  const [seen, setSeen] = React.useState(false);
  React.useEffect(() => {
    if (seen) return;
    const el = ref.current;
    // Fail open: no element, or no IntersectionObserver → show immediately.
    if (!el || !("IntersectionObserver" in window)) { setSeen(true); return; }
    // Fail open: a working IO always delivers an initial callback (even when
    // not intersecting). If none arrives (hidden iframe, print, DOM capture),
    // reveal everything after a short grace period.
    let gotCallback = false;
    const fallback = setTimeout(() => { if (!gotCallback) setSeen(true); }, 900);
    const io = new IntersectionObserver(
      (entries) => {
        gotCallback = true;
        clearTimeout(fallback);
        if (entries[0].isIntersecting) { setSeen(true); io.disconnect(); }
      },
      options || { threshold: 0.18, rootMargin: "0px 0px -48px 0px" }
    );
    io.observe(el);
    return () => { clearTimeout(fallback); io.disconnect(); };
  }, [seen]);
  return [ref, seen];
}

/* Fade-and-rise reveal on first view */
function Reveal({ children, delay = 0, y = 16, style, className, threshold }) {
  const reduced = useReducedMotion();
  const [ref, seen] = useInViewOnce(threshold != null ? { threshold, rootMargin: "0px 0px -48px 0px" } : undefined);
  const shown = reduced || seen;
  return (
    <div ref={ref} className={className} style={{
      ...style,
      opacity: shown ? 1 : 0,
      transform: shown ? "none" : `translateY(${y}px)`,
      transition: reduced ? "none" : `opacity 650ms ${CS_EASE} ${delay}ms, transform 650ms ${CS_EASE} ${delay}ms`,
    }}>{children}</div>
  );
}

/* Renders children only once scrolled into view (lets mount animations play when seen) */
function MountOnView({ children, minHeight = 120 }) {
  const [ref, seen] = useInViewOnce({ threshold: 0.25 });
  return <div ref={ref} style={{ minHeight: seen ? undefined : minHeight }}>{seen ? children : null}</div>;
}

/* Number that counts up when first seen */
function CountUp({ to, decimals = 0, prefix = "", suffix = "", duration = 1100, delay = 0, className, style }) {
  const reduced = useReducedMotion();
  const [ref, seen] = useInViewOnce({ threshold: 0.4 });
  const [val, setVal] = React.useState(reduced ? to : 0);
  React.useEffect(() => {
    if (!seen || reduced) { if (reduced) setVal(to); return; }
    let raf, start;
    const timer = setTimeout(() => {
      const tick = (now) => {
        if (start == null) start = now;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        setVal(to * eased);
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => { clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [seen, reduced, to, duration, delay]);
  return (
    <span ref={ref} className={className} style={{ fontVariantNumeric: "tabular-nums", ...style }}>
      {prefix}{val.toFixed(decimals)}{suffix}
    </span>
  );
}

/* 0→1 progress through a tall sticky-scene wrapper */
function useScrollProgress(ref) {
  const [p, setP] = React.useState(0);
  React.useEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const total = Math.max(1, r.height - window.innerHeight);
      setP(Math.min(1, Math.max(0, -r.top / total)));
    };
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  return p;
}

const csEaseInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

Object.assign(window, {
  CS_EASE, useReducedMotion, useInViewOnce, Reveal, MountOnView, CountUp,
  useScrollProgress, csEaseInOut,
});
