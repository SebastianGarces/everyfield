import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

export function DesignLayout({ children }: { children: ReactNode }) {
	if (process.env.VERCEL_ENV === "production") notFound();
	return children;
}

export function DesignIndexPage() {
	redirect("/design/shell/owner");
}
