/*
 * DS · Wordmark — the "coldstorage" logotype.
 *
 * THE CASING RULE (Ben, 2026-07-20): the WORDMARK is lowercase `coldstorage`; the product
 * NAME in prose is `ColdStorage`. Both are correct, in their own place. The wordmark is a
 * brand artifact — a drawn thing that happens to be made of letters — so it does not inflect
 * with sentence case, and it is never "the start of a sentence".
 *
 * That rule is one keystroke away from being broken every time someone types the brand into
 * a header, which is why the string is not a prop and not exported: to render the wordmark you
 * render this component, and there is no way to hand it different words. `task ssr:check:site`
 * asserts the rendered nav and footer still say `coldstorage`, so a regression fails the build
 * rather than shipping a subtly wrong logo.
 *
 * Typography is the `--type-wordmark` role (Outfit 600, tracking -0.015em per the brand board).
 * Colour is inherited, so the same component works on light and dark grounds untouched.
 */
import "./wordmark.css";

export type WordmarkProps = {
  /** Extra class for caller-side sizing — the lockups on /brand set a larger font-size. */
  className?: string;
};

export function Wordmark({ className }: WordmarkProps) {
  return <span className={`csf-wordmark${className ? ` ${className}` : ""}`}>coldstorage</span>;
}
