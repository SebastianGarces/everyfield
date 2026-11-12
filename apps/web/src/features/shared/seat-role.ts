// The owner-or-admin check the People, Meetings and Communication features share for their write controls. It only
// decides what a page offers: each write still rechecks authority inside its transaction. Relative imports only, so
// node tests can import it by path.

/** Owners and Admins of the plant may write; every other seat role reads. */
export const canWrite = (viewer: { role: string }) => viewer.role === "owner" || viewer.role === "admin";
