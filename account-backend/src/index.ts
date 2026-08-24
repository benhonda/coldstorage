import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { healthRoute } from "./routes/health.js";
import { keyBlobRoute } from "./routes/key-blob.js";
import { accountRoute } from "./routes/account.js";
import { entitlementRoute } from "./routes/entitlement.js";
import { subscriptionRoute } from "./routes/subscription.js";
import { checkoutSessionRoute } from "./routes/checkout-session.js";
import { catalogRoute } from "./routes/catalog.js";
import { checkoutRoute } from "./routes/checkout.js";
import { retrievalRoute } from "./routes/retrieval.js";
import { paddleWebhookRoute } from "./routes/webhooks/paddle.js";

const app = new Hono();

app.get("/", (c) => c.text("coldstorage-account-backend"));
app.route("/health", healthRoute);
app.route("/key-blob", keyBlobRoute);
app.route("/account", accountRoute);
app.route("/entitlement", entitlementRoute);
app.route("/subscription", subscriptionRoute);
app.route("/checkout-session", checkoutSessionRoute);
app.route("/catalog", catalogRoute);
app.route("/checkout", checkoutRoute);
app.route("/retrieval", retrievalRoute);
app.route("/webhooks/paddle", paddleWebhookRoute);

/**
 * Every client of this API (the Electron app's managers, the site's /checkout) reads errors as
 * `{ message }` JSON. Hono's own `HTTPException.getResponse()` renders the message as text/plain,
 * so a `res.json()` on the other end yields null and the detail we took care to write — "reading the
 * payment method failed: forbidden: not authorized to read payment_method" — collapses into a bare
 * "http 502". Render them as JSON here, once, for all routes: the diagnosis reaches the human.
 */
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.res ? err.getResponse() : c.json({ message: err.message }, err.status);
  }
  console.error(err);
  return c.json({ message: "internal error" }, 500);
});

export default app;
