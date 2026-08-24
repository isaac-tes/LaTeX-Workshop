import * as path from 'path'
import { lw } from '../../../src/lw'
import { getPath } from './paths'

/**
 * Sets the active LaTeX root file and its directory in the extension state.
 * Use this when a unit test needs to execute root-dependent behavior.
 */
export function setRoot(...paths: string[]): string {
    const rootFile = getPath(...paths)
    lw.root.file.path = rootFile
    lw.root.file.langId = 'latex'
    lw.root.dir.path = path.dirname(rootFile)
    return rootFile
}

/**
 * Clears the active root file and directory from the extension state.
 * Use this during test cleanup or before testing root-less behavior.
 */
export function resetRoot(): void {
    lw.root.file.path = undefined
    lw.root.dir.path = undefined
}

/**
 * Resets the extension cache between tests.
 * Use this in cleanup after a test has exercised cache-backed behavior.
 */
export function resetCache(): void {
    lw.cache.reset()
}
