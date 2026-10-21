/**
 * After a submit that failed validation, moves keyboard focus to the first control marked invalid, or to the first
 * focusable part of an invalid group (a radio group), once React has drawn the errors.
 */
export function focusFirstInvalid(form: HTMLFormElement) {
	requestAnimationFrame(() => {
		const bad = form.querySelector<HTMLElement>('[aria-invalid="true"]');
		const target = bad?.matches("input, textarea, button, select")
			? bad
			: bad?.querySelector<HTMLElement>('input, textarea, button, [tabindex]:not([tabindex="-1"])');
		target?.focus();
	});
}
