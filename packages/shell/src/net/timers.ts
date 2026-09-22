/**
 * Whatever a `setTimeout` hands back. It is only ever handed back to the
 * matching clear, never read, so the shape does not matter, and it differs:
 * the browser gives a number, Node, where the tests run, gives an object,
 * and the fakes in the tests count.
 */
export type TimerHandle = number | ReturnType<typeof globalThis.setTimeout>;
