import contract from "../../../reclaim.constants.json";

/**
 * The reclamation constants, read from the repo-root `reclaim.constants.json` SSOT — the same file the
 * daemon's Swift is pinned to (`ReclaimConstantsTests`), Terraform's lifecycle rule is fed from
 * (`infra/coldstorage/root.hcl`), and `daemon:gate-test` asserts against.
 *
 * The app's stake in it is the **delete confirmation**: it tells the user when their space comes back. That
 * sentence used to state "180 days" as a literal, which made the UI a fifth independent spelling of a number
 * the bucket actually decides — so a change to the lifecycle rule would have left the app quietly promising
 * the wrong date to every customer who deletes something. Build the copy from this, never from a literal.
 *
 * Imported at build time (bundled), not fetched — there is no runtime dependency on the file existing on
 * the user's machine.
 */
export const RECLAIM = {
  /** Deep Archive's minimum billable duration, and therefore when a deleted file's space returns. */
  minimumStorageDays: contract.minimumStorageDays,
} as const;
