import { FONT, escapeHtml, renderBody, type RenderMode } from "./html.ts";

export type EmailContext = { churchName: string; mailingAddress: string | null; unsubscribeUrl?: string };
export type ChurchAddress = {
	street: string | null;
	city: string | null;
	stateProvince: string | null;
	country: string | null;
};

const MISSING_ADDRESS = "Mailing address missing. Add it in Church profile before this email can go out.";

const line = (value: string | null) => value?.replace(/\s+/g, " ").trim() || null;

export function mailingAddress(address: ChurchAddress): string | null {
	const street = line(address.street);
	const city = line(address.city);
	const country = line(address.country);
	if (!street || !city || !country) return null;
	return [street, city, line(address.stateProvince), country].filter(Boolean).join(", ");
}

const INK = "#181D19";

const blockStyles: Record<string, string> = {
	p: "margin:0 0 14px 0;font-size:16px;line-height:1.6;color:#3A3F3B;",
	h1: "margin:0 0 12px 0;font-size:28px;line-height:1.15;font-weight:400;color:#181D19;",
	h2: "margin:0 0 12px 0;font-size:22px;line-height:1.2;font-weight:600;color:#181D19;",
	h3: "margin:0 0 10px 0;font-size:18px;line-height:1.3;font-weight:600;color:#181D19;",
	ul: "margin:0 0 14px 0;padding-left:22px;font-size:16px;line-height:1.6;color:#3A3F3B;",
	ol: "margin:0 0 14px 0;padding-left:22px;font-size:16px;line-height:1.6;color:#3A3F3B;",
	li: "margin:0 0 4px 0;",
	blockquote:
		"margin:0 0 14px 0;padding-left:14px;border-left:3px solid #E7E4DE;font-size:16px;line-height:1.6;color:#3A3F3B;",
};

function inlineStyles(body: string): string {
	return body
		.replace(/<(p|h1|h2|h3|ul|ol|li|blockquote)>/g, (_m, tag: string) => `<${tag} style="${blockStyles[tag]}">`)
		.replace(/<a href="([^"]*)">/g, '<a href="$1" style="color:#181D19;text-decoration:underline;">');
}

function initials(name: string): string {
	const letters = name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((word) => Array.from(word)[0]!.toUpperCase());
	return letters.join("") || "•";
}

function addressLine(church: string, address: string | null): string {
	if (address === null) return `<span data-mailing-address="missing" style="color:#B42318;">${MISSING_ADDRESS}</span>`;
	return `<span data-mailing-address>${church} · ${escapeHtml(address)}</span>`;
}

export function renderEmailText(body: string, context: EmailContext): string {
	const church = context.churchName.trim() || "Your church";
	const address = context.mailingAddress;
	const footer = [
		`You get this email because you are part of ${church}.`,
		address === null ? MISSING_ADDRESS : `${church} · ${address}`,
		...(context.unsubscribeUrl ? [`Unsubscribe: ${context.unsubscribeUrl}`] : []),
	];
	return `${body}\n\n--\n${footer.join("\n")}`;
}

function unsubscribeLink(url: string | undefined): string {
	if (!url) return "";
	return ` <a href="${escapeHtml(url)}" style="color:#666A64;text-decoration:underline;">Unsubscribe</a>`;
}

export function renderEmailHtml(
	body: string,
	merge: Readonly<Record<string, string>>,
	context: EmailContext,
	mode: RenderMode = "send",
): string {
	const church = escapeHtml(context.churchName.trim() || "Your church");
	const content = inlineStyles(renderBody(body, merge, mode));
	return (
		`<!DOCTYPE html><html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>` +
		`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">` +
		`<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->` +
		`<title>${church}</title></head>` +
		`<body style="margin:0;padding:0;background-color:#F4F2EE;font-family:${FONT};color:${INK};">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F4F2EE" style="background-color:#F4F2EE;"><tr>` +
		`<td align="center" style="padding:22px 18px 26px 18px;">` +
		`<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">` +
		`<tr><td style="padding:4px 6px 16px 6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
		`<td width="34" height="34" align="center" valign="middle" bgcolor="${INK}" style="width:34px;height:34px;background-color:${INK};color:#F6F0E9;font-family:${FONT};font-size:13px;font-weight:700;">${escapeHtml(initials(context.churchName))}</td>` +
		`<td style="padding-left:10px;font-family:${FONT};font-size:15px;font-weight:600;color:${INK};">${church}</td>` +
		`</tr></table></td></tr>` +
		`<tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;padding:30px 30px 28px 30px;font-family:${FONT};font-size:16px;line-height:1.6;color:#3A3F3B;">${content}</td></tr>` +
		`<tr><td align="center" style="padding:18px 10px 0 10px;font-family:${FONT};font-size:12.5px;line-height:1.6;color:#666A64;">You get this email because you are part of ${church}.${unsubscribeLink(context.unsubscribeUrl)}<br>${addressLine(church, context.mailingAddress)}</td></tr>` +
		`</table>` +
		`<!--[if mso]></td></tr></table><![endif]-->` +
		`</td></tr></table></body></html>`
	);
}
