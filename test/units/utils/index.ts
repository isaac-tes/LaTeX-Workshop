import { getFixture, getPath, getWorkspace } from './paths'
import { setCodeConfig, setConfig, resetConfig } from './configuration'
import { resetCache, resetRoot, setRoot } from './state'
import { getCompilerLog, log, resetLog } from './logging'

export { assert } from './assertions'
export { collectAsync, deferred, flushImmediate, sleep, waitFor } from './async'
export type { Deferred, WaitForOptions } from './async'
export { mock } from './mocks'
export { TextDocument, TextEditor } from './vscode-fakes'
export { hooks } from './lifecycle'

/**
 * Provides paths, workspace lookup, fixture lookup, and compiler-log access
 * through the legacy `get.*` test API.
 */
export const get = {
    fixture: getFixture,
    workspace: getWorkspace,
    path: getPath,
    compiler: {
        log: getCompilerLog
    }
}

/**
 * Provides the legacy `set.*` test-state and configuration API.
 * Prefer these helpers over mutating extension state directly in a test.
 */
export const set = {
    root: setRoot,
    config: setConfig,
    codeConfig: setCodeConfig
}

/**
 * Provides the legacy `reset.*` cleanup API for root, cache, configuration,
 * and log state.
 */
export const reset = {
    root: resetRoot,
    cache: resetCache,
    config: resetConfig,
    log: resetLog
}

/**
 * Provides the legacy log capture API used by existing unit tests.
 */
export { log }
