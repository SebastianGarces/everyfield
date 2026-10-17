/** Reader input that ends the hold on a #fragment target (see PageScroll). */
export const READER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

declare global {
  interface Window {
    /** performance.now() of the reader's latest wheel, touch, pointer or key input, recorded from the first parse. */
    __readerInputAt?: number;
  }
}

/**
 * Inline script at the top of the body, before any page content or framework code: it records the time of every reader
 * input, so input made before hydration (slow JS) is not lost. The one inline script on the site (R5 exception).
 */
export const READER_INPUT_SCRIPT =
  `${JSON.stringify(READER_INPUT)}.forEach(function(t){addEventListener(t,function(){window.__readerInputAt=performance.now()},{capture:true,passive:true})})`;

/** The same inline script marks the root with data-js before any content parses. Without JavaScript the attribute is
 *  missing, so CSS (variant [html:not([data-js])_&]) can show a finished picture where a script-driven one stays hidden. */
export const JS_FLAG_SCRIPT = `document.documentElement.setAttribute("data-js","")`;
