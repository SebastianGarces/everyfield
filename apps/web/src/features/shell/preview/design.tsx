import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { isTestDeployment } from "@everyfield/db/deployment";

export function DesignLayout({ children }: { children: ReactNode }) {
	if (!isTestDeployment(process.env)) notFound();
	return children;
}

export function DesignIndexPage() {
	redirect("/design/shell/owner");
}
