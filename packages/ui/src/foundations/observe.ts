export type NodeRef<T extends Element> = (node: T | null) => (() => void) | undefined;

export type SizeOptions<T extends Element> = {
	also?: (node: T) => Iterable<Element | null | undefined>;
	fonts?: boolean;
	viewport?: boolean;
	measureOnAttach?: boolean;
};

export function observeSize<T extends Element>(onResize: (node: T) => void, options: SizeOptions<T> = {}): NodeRef<T> {
	return (node) => {
		if (!node) return;
		let attached = true;
		const measure = () => {
			if (attached) onResize(node);
		};
		if (options.measureOnAttach !== false) measure();
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

export type ScrollOptions<T extends Element> = {
	root?: (node: T) => Element | null;
};

export function observeScroll<T extends Element>(
	onScroll: (node: T) => void,
	options: ScrollOptions<T> = {},
): NodeRef<T> {
	return (node) => {
		if (!node) return;
		const root = options.root?.(node) ?? null;
		const scrolled = () => onScroll(node);
		if (root) {
			root.addEventListener("scroll", scrolled, { passive: true });
			return () => root.removeEventListener("scroll", scrolled);
		}
		window.addEventListener("scroll", scrolled, { passive: true });
		return () => window.removeEventListener("scroll", scrolled);
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
		const [firstId] = ids;
		if (!container || firstId === undefined) return;
		const doc = container.ownerDocument;
		const root = options.root?.(container) ?? null;
		const offset = typeof options.offset === "function" ? options.offset(root) : (options.offset ?? 120);
		let active: string | undefined;
		const update = () => {
			const line = (root ? root.getBoundingClientRect().top : 0) + offset;
			let current = firstId;
			for (const id of ids) {
				const heading = doc.getElementById(id);
				if (heading && heading.getBoundingClientRect().top <= line) current = id;
			}
			if (current === active) return;
			active = current;
			onActive(current);
		};
		update();
		return observeScroll<HTMLElement>(update, { root: () => root })(container);
	};
}

export function observeScrollProgress<T extends HTMLElement>(
	onProgress: (fraction: number) => void,
	options: ScrollOptions<T> = {},
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
		const stopSize = observeSize<T>(report, { also: () => [root], viewport: !root, measureOnAttach: false })(node);
		const stopScroll = observeScroll<T>(report, { root: () => root })(node);
		return () => {
			stopSize?.();
			stopScroll?.();
		};
	};
}
