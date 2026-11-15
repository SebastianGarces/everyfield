export type NodeRef<T extends Element> = (node: T | null) => (() => void) | undefined;

export type SizeOptions<T extends Element> = {
	also?: (node: T) => Iterable<Element | null | undefined>;
	fonts?: boolean;
	viewport?: boolean;
};

export function observeSize<T extends Element>(onResize: (node: T) => void, options: SizeOptions<T> = {}): NodeRef<T> {
	return (node) => {
		if (!node) return;
		let attached = true;
		const measure = () => {
			if (attached) onResize(node);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		for (const other of options.also?.(node) ?? []) if (other) observer.observe(other);
		if (options.fonts) void document.fonts.ready.then(measure);
		if (options.viewport) window.addEventListener("resize", measure, { passive: true });
		return () => {
			attached = false;
			observer.disconnect();
			if (options.viewport) window.removeEventListener("resize", measure);
		};
	};
}

export function observeIntersection<T extends Element>(
	onChange: (entry: IntersectionObserverEntry, stop: () => void) => void,
	init?: IntersectionObserverInit,
): NodeRef<T> {
	return (node) => {
		if (!node) return;
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) onChange(entry, stop);
		}, init);
		const stop = () => observer.disconnect();
		observer.observe(node);
		return stop;
	};
}

export type HeadingOptions = {
	offset?: number | ((root: Element | null) => number);
	root?: (container: HTMLElement) => Element | null;
};

export function observeHeadings(
	ids: readonly string[],
	onActive: (id: string) => void,
	options: HeadingOptions = {},
): NodeRef<HTMLElement> {
	return (container) => {
		if (!container || ids.length === 0) return;
		const doc = container.ownerDocument;
		const root = options.root?.(container) ?? null;
		const offset = typeof options.offset === "function" ? options.offset(root) : (options.offset ?? 120);
		let active: string | undefined;
		const update = () => {
			const line = (root ? root.getBoundingClientRect().top : 0) + offset;
			let current = ids[0]!;
			for (const id of ids) {
				const heading = doc.getElementById(id);
				if (heading && heading.getBoundingClientRect().top <= line) current = id;
			}
			if (current === active) return;
			active = current;
			onActive(current);
		};
		update();
		if (root) {
			root.addEventListener("scroll", update, { passive: true });
			return () => root.removeEventListener("scroll", update);
		}
		window.addEventListener("scroll", update, { passive: true });
		return () => window.removeEventListener("scroll", update);
	};
}

export type ScrollProgressOptions<T extends Element> = {
	root?: (node: T) => Element | null;
};

export function observeScrollProgress<T extends HTMLElement>(
	onProgress: (fraction: number) => void,
	options: ScrollProgressOptions<T> = {},
): NodeRef<T> {
	return (node) => {
		if (!node) return;
		const root = options.root?.(node) ?? null;
		const report = () => {
			const total = node.scrollHeight;
			if (total <= 0) return;
			const edge = root ? root.getBoundingClientRect().bottom : window.innerHeight;
			const seen = Math.min(total, Math.max(0, edge - node.getBoundingClientRect().top));
			onProgress(seen / total);
		};
		const resized = new ResizeObserver(report);
		resized.observe(node);
		if (root) {
			resized.observe(root);
			root.addEventListener("scroll", report, { passive: true });
			return () => {
				resized.disconnect();
				root.removeEventListener("scroll", report);
			};
		}
		window.addEventListener("scroll", report, { passive: true });
		window.addEventListener("resize", report, { passive: true });
		return () => {
			resized.disconnect();
			window.removeEventListener("scroll", report);
			window.removeEventListener("resize", report);
		};
	};
}
