import type { ComponentProps } from "react";

export function NativeImage({ alt, ...image }: ComponentProps<"img"> & { alt: string }) {
	return <img alt={alt} {...image} />;
}

export function FullPageLink(props: ComponentProps<"a">) {
	return <a {...props} />;
}
