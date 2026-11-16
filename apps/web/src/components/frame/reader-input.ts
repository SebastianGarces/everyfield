export const READER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

declare global {
	interface Window {
		__readerInputAt?: number;
	}
}

export const READER_INPUT_SCRIPT = `${JSON.stringify(READER_INPUT)}.forEach(function(t){addEventListener(t,function(){window.__readerInputAt=performance.now()},{capture:true,passive:true})})`;

export const JS_FLAG_SCRIPT = `document.documentElement.setAttribute("data-js","")`;
