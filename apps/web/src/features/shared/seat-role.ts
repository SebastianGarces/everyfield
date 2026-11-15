export const canWrite = (viewer: { role: string }) => viewer.role === "owner" || viewer.role === "admin";
