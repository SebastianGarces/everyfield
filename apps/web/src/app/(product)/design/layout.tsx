import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Design preview", robots: { index: false, follow: false } };

export default function DesignLayout({ children }: { children: ReactNode }) {
	if (process.env.VERCEL_ENV === "production") notFound();
	return children;
}
