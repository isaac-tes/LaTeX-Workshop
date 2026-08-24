export type Deferred<T> = {
    promise: Promise<T>,
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void
}

/**
 * Creates a promise whose completion is controlled by the test.
 * Use it to hold a mocked operation at a precise point and release it later;
 * do not use it when the production event or promise can be awaited directly.
 */
export function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>['resolve']
    let reject!: Deferred<T>['reject']
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve
        reject = promiseReject
    })
    return {promise, resolve, reject}
}

/**
 * Collects every value from an async iterable in arrival order.
 * Use it in tests that need to compare a generator's complete output instead
 * of repeating the same `for await` collection loop in each fixture.
 */
export async function collectAsync<T>(source: AsyncIterable<T>): Promise<T[]> {
    const values: T[] = []
    for await (const value of source) {
        values.push(value)
    }
    return values
}

/**
 * Yields to the next Node.js immediate callback.
 * Use it after triggering code backed by `setImmediate`; it is not a wait for
 * a real external event and should not replace an event-specific promise.
 */
export function flushImmediate(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve))
}

/**
 * Gives pending asynchronous work one event-loop turn to progress.
 * This is an implementation detail of `waitFor`, not a signal that the code
 * under test is specifically scheduled with `setImmediate`.
 */
function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve))
}

export type WaitForOptions = {
    timeout?: number,
    interval?: number,
    message?: string
}

/**
 * Waits until a synchronous predicate becomes true, with a bounded timeout.
 * Use it as a fallback for state that has no awaitable notification; prefer a
 * deferred promise or a listener attached to the event under test when either
 * is available.
 */
export async function waitFor(
    predicate: () => boolean,
    {timeout = 1000, interval = 10, message = 'Timed out waiting for condition.'}: WaitForOptions = {}
): Promise<void> {
    const deadline = Date.now() + timeout
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(message)
        }
        await (interval > 0 ? sleep(interval) : yieldToEventLoop())
    }
}

/**
 * Delays a test until the requested number of milliseconds has elapsed.
 * Use only when the behavior under test is explicitly time-based; prefer an
 * event, a deferred promise, or fake timers for ordinary asynchronous work.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
