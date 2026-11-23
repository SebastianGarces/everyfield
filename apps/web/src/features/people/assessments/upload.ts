import { sendTwice, type Outcome } from "../../../components/save/model.ts";
import { saveCommitmentWithDocument, signCommitmentUpload, type CommitmentSaved } from "./actions.ts";

type Signed = Extract<Awaited<ReturnType<typeof signCommitmentUpload>>, { status: "ok" }>["value"];
export type DocumentUpload = { file: File; signed: Signed | null; signedAt: number; put: "none" | "sent" | "stored" };
export const newUpload = (file: File): DocumentUpload => ({ file, signed: null, signedAt: 0, put: "none" });
export const reusable = (u: DocumentUpload | undefined): u is DocumentUpload =>
	!!u && u.put === "stored" && Date.now() - u.signedAt < 10 * 60_000;

function putFile(
	signed: Signed,
	file: File,
	onProgress: (share: number) => void,
): Promise<"stored" | "lost" | "refused"> {
	return new Promise((done) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", signed.url);
		for (const [name, value] of Object.entries(signed.headers)) xhr.setRequestHeader(name, value);
		xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
		xhr.onload = () =>
			done(
				(xhr.status >= 200 && xhr.status < 300) || xhr.status === 412
					? "stored"
					: xhr.status >= 500
						? "lost"
						: "refused",
			);
		xhr.onerror = xhr.ontimeout = xhr.onabort = () => done("lost");
		xhr.send(file);
	});
}

const refusal = (code: string): Outcome<never> => ({ status: "refused", code });
const signProblem = (code: string) => (code === "storage_unavailable" ? code : "upload_failed");

export async function saveWithDocument(
	key: string,
	input: Record<string, unknown> & { personId: string },
	upload: DocumentUpload,
	onProgress: (share: number | null) => void,
): Promise<Outcome<CommitmentSaved>> {
	const { file } = upload;
	let signed = upload.signed;
	if (!signed || (upload.put === "none" && Date.parse(signed.expiresAt) - Date.now() < 30_000)) {
		const issued = await sendTwice(() =>
			signCommitmentUpload({ personId: input.personId, mime: file.type, byteLength: file.size }),
		);
		if (issued.status === "lost") return refusal("upload_lost");
		if (issued.status === "refused") return refusal(signProblem(issued.code));
		signed = issued.value;
		Object.assign(upload, { signed, signedAt: Date.now(), put: "none" });
	}
	const put = async () => {
		upload.put = "sent";
		onProgress(0);
		const answer = await putFile(signed, file, onProgress);
		onProgress(null);
		if (answer === "stored") upload.put = "stored";
		return answer;
	};
	if (upload.put === "none") {
		const answer = await put();
		if (answer === "refused") return refusal("upload_failed");
	}
	const save = () => sendTwice(() => saveCommitmentWithDocument(key, { ...input, documentUploadId: signed.uploadId }));
	let saved = await save();
	if (upload.put === "sent" && saved.status === "refused" && saved.code === "unavailable") {
		if ((await put()) !== "stored") return refusal("upload_lost");
		saved = await save();
	}
	if (saved.status === "ok") upload.put = "stored";
	return saved;
}
