/**
 * Whatever `setTimeout` returns, only ever passed back to the matching clear: a
 * number in the browser, an object in Node, a count in the fakes.
 */
export type TimerHandle = number | ReturnType<typeof globalThis.setTimeout>;
