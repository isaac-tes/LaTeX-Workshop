/**
 * Delays a test until the requested number of milliseconds has elapsed.
 * Use only when the behavior under test is explicitly time-based; prefer an
 * event, a deferred promise, or fake timers for ordinary asynchronous work.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
