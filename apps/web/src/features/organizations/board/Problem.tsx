/** Why a change didn't save, announced politely; nothing while there is no problem. */
export function Problem({ text }: { text: string | null }) {
	return (
		<div aria-live="polite" className="empty:hidden">
			{text ? <p className="rounded-md bg-magenta-50 px-3 py-2.5 text-sm text-magenta-600">{text}</p> : null}
		</div>
	);
}
