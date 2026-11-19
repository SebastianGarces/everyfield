import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { isTestDeployment } from "@everyfield/db/deployment";
import { serverEnv } from "../../../server/config.ts";

export function DesignLayout({ children }: { children: ReactNode }) {
	if (!isTestDeployment(serverEnv())) notFound();
	return children;
}

export function DesignIndexPage() {
	redirect("/design/shell/owner");
}
