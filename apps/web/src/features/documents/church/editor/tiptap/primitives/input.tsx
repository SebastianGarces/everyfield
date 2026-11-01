import * as React from "react";
import { cn } from "../tiptap-utils.ts";
import { INPUT, INPUT_GROUP } from "../styles.ts";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return <input type={type} className={cn(INPUT, className)} {...props} />;
}

function InputGroup({ className, children, ...props }: React.ComponentProps<"div">) {
	return (
		<div className={cn(INPUT_GROUP, className)} {...props}>
			{children}
		</div>
	);
}

export { Input, InputGroup };
