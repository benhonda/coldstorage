import type { SubscriptionStatus } from "@paddle/paddle-node-sdk";

/** The only statuses that should leave uploads enabled — everything else gates them off. */
export function isActiveStatus(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing";
}
