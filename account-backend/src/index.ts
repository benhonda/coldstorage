import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { keyBlobRoute } from "./routes/key-blob.js";
import { entitlementRoute } from "./routes/entitlement.js";
import { subscriptionRoute } from "./routes/subscription.js";
import { checkoutSessionRoute } from "./routes/checkout-session.js";
import { catalogRoute } from "./routes/catalog.js";
import { checkoutRoute } from "./routes/checkout.js";
import { retrievalRoute } from "./routes/retrieval.js";
import { paddleWebhookRoute } from "./routes/webhooks/paddle.js";

const app = new Hono();

app.get("/", (c) => c.text("coldstorage-account-backend"));
app.route("/key-blob", keyBlobRoute);
app.route("/entitlement", entitlementRoute);
app.route("/subscription", subscriptionRoute);
app.route("/checkout-session", checkoutSessionRoute);
app.route("/catalog", catalogRoute);
app.route("/checkout", checkoutRoute);
app.route("/retrieval", retrievalRoute);
app.route("/webhooks/paddle", paddleWebhookRoute);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

export default app;
