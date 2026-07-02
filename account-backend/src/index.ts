import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { keyBlobRoute } from "./routes/key-blob.js";
import { entitlementRoute } from "./routes/entitlement.js";
import { paddleWebhookRoute } from "./routes/webhooks/paddle.js";

const app = new Hono();

app.get("/", (c) => c.text("coldstorage-account-backend"));
app.route("/key-blob", keyBlobRoute);
app.route("/entitlement", entitlementRoute);
app.route("/webhooks/paddle", paddleWebhookRoute);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

export default app;
