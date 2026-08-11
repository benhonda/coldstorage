/**
 * Renders the REAL template with the REAL react-email renderer and asserts on the bytes we'd hand to
 * CD2 — the point being that a broken template is a person who can't sign in, and that failure should
 * happen here rather than in someone's inbox.
 */
import { describe, expect, test } from "bun:test";
import { render } from "@react-email/render";
import { createElement } from "react";
import { CodeEmail } from "./emails/code-email.js";
import { messageFor } from "./messages.js";

const message = messageFor("CustomEmailSender_Authentication");
if (!message) throw new Error("the authentication message went missing");

const CODE = "482915";

describe("CodeEmail", () => {
  test("the HTML carries the code, the copy and the brand", async () => {
    const html = await render(createElement(CodeEmail, { ...message, code: CODE }));
    expect(html).toContain(CODE);
    // Substring, not the whole line: react-email HTML-escapes the apostrophe in "Here's".
    expect(html).toContain("code to finish signing in");
    expect(html).toContain("coldstorage"); // the lowercase wordmark (ds/wordmark.tsx casing rule)
    expect(html).toContain("https://coldstorage.sh");
    // Inline styles are the only ones email clients reliably keep — a <style>-only render would
    // arrive unstyled, so assert the card's background actually made it onto an element.
    expect(html).toContain("#FFFFFF");
  });

  test("the plain-text alternative still carries the code", async () => {
    const text = await render(createElement(CodeEmail, { ...message, code: CODE }), { plainText: true });
    expect(text).toContain(CODE);
    expect(text).not.toContain("<div");
  });

  test("the code is text, never an image — it has to be copy-pasteable", async () => {
    const html = await render(createElement(CodeEmail, { ...message, code: CODE }));
    expect(html).not.toContain("<img");
  });

  test("a code with regex-hostile characters would still render verbatim", async () => {
    // Cognito's codes are digits today; this pins that we interpolate rather than pattern-substitute,
    // so a future code format can't silently mangle or vanish.
    const odd = "a&b<c>";
    const html = await render(createElement(CodeEmail, { ...message, code: odd }));
    expect(html).toContain("a&amp;b&lt;c&gt;"); // escaped, present, not dropped
  });
});
