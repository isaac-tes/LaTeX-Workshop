import * as fs from 'fs'
import * as path from 'path'
import { log as lwLog } from '../../../src/utils/logger'
import { resetConfig } from './configuration'
import { resetLog } from './logging'
import { resetCache, resetRoot } from './state'

/**
 * Writes the current extension log to the test log tree using the Mocha test name.
 * This is an internal cleanup helper used by `hooks.afterEach`.
 */
function cacheLog(context: Mocha.Context): void {
    /** Converts a Mocha title into a filesystem-safe log name. */
    function sanitize(name: string): string {
        return name.replace(/[^a-z0-9_]/gi, '_').replace(/_{2,}/gi, '_').toLowerCase()
    }
    const name = sanitize(context.currentTest?.title ?? '')

    const cachedLog = lwLog.getCachedLog()
    const folders = []
    let parent = context.currentTest?.parent
    while(parent && parent.title !== '') {
        folders.unshift(sanitize(parent.title.replaceAll(':', '')))
        parent = parent.parent
    }
    const logFolder = path.resolve(__dirname, '../../../../test/log', 'unittest', ...folders)
    fs.mkdirSync(logFolder, {recursive: true})
    fs.writeFileSync(path.resolve(logFolder, `${name}.log`), cachedLog.CACHED_EXTLOG.join('\n'))
}

/**
 * Resets the per-test log capture range before each unit test.
 * Use this as the suite-level `beforeEach` hook.
 */
export function beforeEach(): void {
    resetLog()
}

/**
 * Persists the test log and restores cache, root, and configuration state.
 * Use this as the suite-level `afterEach` hook.
 */
export async function afterEach(this: Mocha.Context): Promise<void> {
    cacheLog(this)
    resetCache()
    resetRoot()
    await resetConfig()
}

/**
 * Provides the standard cleanup hooks shared by the unit-test files.
 */
export const hooks = {
    beforeEach,
    afterEach
}
