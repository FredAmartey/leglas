/**
 * Whatever a timer function returns, only ever passed back to the matching
 * clear: Node gives a `Timeout`, the test fakes a count.
 */
export type TimerHandle = number | ReturnType<typeof setTimeout>;
