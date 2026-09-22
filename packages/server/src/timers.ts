/**
 * Whatever a timer function hands back. It is only ever handed back to the
 * matching clear, never read: Node gives a `Timeout`, and the fakes in the
 * tests count.
 */
export type TimerHandle = number | ReturnType<typeof setTimeout>;
