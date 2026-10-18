// The restricted preview pages. Kept out of the client module so the server route can read the list.
export type RestrictedFlow = "account-deletion" | "workspace-deletion" | "confirm-email";
export const RESTRICTED_FLOWS: readonly RestrictedFlow[] = ["account-deletion", "workspace-deletion", "confirm-email"];
