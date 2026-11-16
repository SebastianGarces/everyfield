let lastReset: Event | null = null;

if (typeof document !== "undefined")
	document.addEventListener(
		"reset",
		(event) => {
			lastReset = event;
		},
		true,
	);

export const duringFormReset = () => lastReset !== null && lastReset.eventPhase !== Event.NONE;

export const unlessReset =
	<T>(change: ((value: T) => void) | undefined) =>
	(value: T) => {
		if (!duringFormReset()) change?.(value);
	};
