export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
	if (Number(request.headers.get("content-length") ?? 0) > limit) return null;
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) return Buffer.concat(chunks);
			size += part.value.byteLength;
			if (size > limit) return null;
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel();
	}
}
