import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

// Design previews of the product foundations and AppShell (WP-088). They use invented sample data and no database.
// They are for local previews and review only: production returns 404 and crawlers are told not to index them.
export const metadata: Metadata = { title: "Design preview", robots: { index: false, follow: false } };

export default function DesignLayout({ children }: { children: ReactNode }) {
	if (process.env.VERCEL_ENV === "production") notFound();
	return children;
}
