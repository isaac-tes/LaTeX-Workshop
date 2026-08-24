import { log as lwLog } from '../../../src/utils/logger'

let logStartIndex = 0
let logStopIndex = 0

/**
 * Returns extension log entries captured since the current test's log marker.
 * Use this when a test needs to inspect or print extension log output.
 */
export function getExtensionLogs(): string[] {
    return lwLog.getCachedLog().CACHED_EXTLOG.slice(logStartIndex, logStopIndex ? logStopIndex : undefined)
}

/**
 * Starts a log capture range at the current end of the extension log.
 * Use before invoking code whose log output should be asserted in isolation.
 */
export function startLogCapture(): void {
    logStartIndex = lwLog.getCachedLog().CACHED_EXTLOG.length
}

/**
 * Stops the current log capture range at the current end of the extension log.
 * Use after the operation whose log output is being inspected.
 */
export function stopLogCapture(): void {
    logStopIndex = lwLog.getCachedLog().CACHED_EXTLOG.length
}

/**
 * Provides the legacy log range API used by existing unit tests.
 * Prefer `start()` and `stop()` around a focused operation, then `all()` to inspect it.
 */
export const log = {
    all: getExtensionLogs,
    start: startLogCapture,
    stop: stopLogCapture
}

/**
 * Clears cached logs and resets the current capture range.
 * Use this during test cleanup or before starting a new independent scenario.
 */
export function resetLog(): void {
    lwLog.resetCachedLog()
    logStartIndex = 0
    logStopIndex = 0
}

/**
 * Returns compiler log entries as one string.
 * Use this when a test needs to compare the complete compiler log output.
 */
export function getCompilerLog(): string {
    return lwLog.getCachedLog().CACHED_COMPILER.join('')
}

/**
 * Returns the individual compiler log entries for diagnostic assertions.
 * This is primarily used by the assertion helpers to produce useful failures.
 */
export function compilerLogs(): string[] {
    return lwLog.getCachedLog().CACHED_COMPILER
}

/**
 * Checks whether the current extension log contains a string or regular-expression match.
 * Use for positive log assertions; string messages support logger placeholders.
 */
export function hasLog(message: string | RegExp): boolean {
    return typeof message === 'string'
        ? log.all().some(logMessage => logMessage.includes(lwLog.applyPlaceholders(message)))
        : log.all().some(logMessage => message.exec(logMessage))
}

/**
 * Checks whether the compiler log contains a string or regular-expression match.
 * Use for diagnostics emitted through the compiler log channel.
 */
export function hasCompilerLog(message: string | RegExp): boolean {
    return typeof message === 'string'
        ? compilerLogs().some(logMessage => logMessage.includes(message))
        : compilerLogs().some(logMessage => message.exec(logMessage))
}
