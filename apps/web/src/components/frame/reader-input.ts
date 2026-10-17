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
