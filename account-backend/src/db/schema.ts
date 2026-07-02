import { pgTable, text, integer, boolean } from "drizzle-orm/pg-core";
import { timestamps } from "./schema-utils";

/**
 * One row per user. Keyed on the Cognito **User Pool** `sub` (the ID token's `sub` claim) —
 * NOT the Cognito **Identity Pool** identity id that S3 keys are prefixed with
 * (`blobs/<identity-id>/...`, see infra/coldstorage/modules/stack/cognito.tf). This service
 * never touches S3, so it only ever needs the identity the ID token already carries — no
 * extra AWS call to resolve an identity id.
 *
 * The wrapped-key-blob columns are blind storage for the zero-knowledge MasterKey hierarchy
 * (see coldstorage/Sources/ColdStorageCore/ZeroKnowledgeKeys.swift `KeyBlob`): base64 text,
 * never decrypted or even decodable here — this service holds ciphertext + salts only.
 */
export const accountsTable = pgTable("accounts", {
  ...timestamps,
  sub: text().primaryKey(),

  // KeyBlob (nullable until the app's first signup PUT — see routes/key-blob.ts).
  wrappedMkPassword: text("wrapped_mk_password"),
  saltPassword: text("salt_password"),
  wrappedMkRecovery: text("wrapped_mk_recovery"),
  saltRecovery: text("salt_recovery"),
  opsLimit: integer("ops_limit"),
  memLimit: integer("mem_limit"),

  // Paddle subscription state (flipped by the webhook — see routes/webhooks/paddle.ts).
  subscriptionActive: boolean("subscription_active").notNull().default(false),
  paddleCustomerId: text("paddle_customer_id"),
  paddleSubscriptionId: text("paddle_subscription_id"),
});
