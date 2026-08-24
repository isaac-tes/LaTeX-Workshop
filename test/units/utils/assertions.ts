import * as os from 'os'
import * as path from 'path'
import * as nodeAssert from 'assert'
import { compilerLogs, hasCompilerLog, hasLog, log } from './logging'

type ExtendedAssert = typeof nodeAssert & {
    listStrictEqual: <T>(actual: T[] | undefined, expected: T[] | undefined, message?: string | Error) => void,
    pathStrictEqual: (actual: string | undefined, expected: string | undefined, message?: string | Error) => void,
    pathNotStrictEqual: (actual: string | undefined, expected: string | undefined, message?: string | Error) => void,
    pathListStrictEqual: (actual: string[] | undefined, expected: string[] | undefined, message?: string | Error) => void,
    hasLog: (message: string | RegExp) => void,
    notHasLog: (message: string | RegExp) => void,
    hasCompilerLog: (message: string | RegExp) => void
}

/**
 * Provides Node's assertions together with assertions shared by unit tests.
 * Use this instead of importing `assert` directly when a test also needs path
 * or log assertions.
 */
export const assert: ExtendedAssert = nodeAssert as ExtendedAssert

/**
 * Compares two lists without requiring a particular ordering.
 * Use this for results whose order is not part of the behavior under test.
 */
export function listStrictEqual<T>(actual: T[] | undefined, expected: T[] | undefined, message?: string | Error): void {
    if (actual === undefined || expected === undefined) {
        assert.strictEqual(actual, expected)
    } else {
        assert.deepStrictEqual(actual.sort(), expected.sort(), message)
    }
}

/**
 * Normalizes two paths before a platform-independent comparison.
 * This is an implementation detail shared by the path assertion helpers.
 */
function getPaths(actual: string | undefined, expected: string | undefined): [string, string] {
    actual = path.normalize(actual ?? '.')
    expected = path.normalize(expected ?? '.')
    if (os.platform() === 'win32') {
        actual = actual.replace(/^([a-zA-Z]):/, (_, p1: string) => p1.toLowerCase() + ':')
        expected = expected.replace(/^([a-zA-Z]):/, (_, p1: string) => p1.toLowerCase() + ':')
    }
    return [actual, expected]
}

/**
 * Compares two paths after normalizing separators and Windows drive letters.
 * Use this whenever a test compares paths produced by the extension.
 */
export function pathStrictEqual(actual: string | undefined, expected: string | undefined, message?: string | Error): void {
    [actual, expected] = getPaths(actual, expected)
    assert.strictEqual(path.relative(actual, expected), '', message ?? `Paths are not equal: ${actual} !== ${expected} .`)
}

/**
 * Asserts that two normalized paths are different.
 * Use this for tests that verify two files or workspace locations do not alias.
 */
export function pathNotStrictEqual(actual: string | undefined, expected: string | undefined, message?: string | Error): void {
    [actual, expected] = getPaths(actual, expected)
    assert.notStrictEqual(path.relative(actual, expected), '', message ?? `Paths are equal: ${actual} === ${expected} .`)
}

/**
 * Compares path lists element by element using normalized path semantics.
 * Use this when list order is meaningful but the platform-specific spelling is not.
 */
export function pathListStrictEqual(actual: string[] | undefined, expected: string[] | undefined, message?: string | Error): void {
    if (actual === undefined || expected === undefined) {
        assert.strictEqual(actual, expected)
    } else {
        assert.strictEqual(
            actual.length,
            expected.length,
            message ?? `Path lists have different lengths: ${actual} !== ${expected} .`
        )

        actual.forEach((actualPath, index) => {
            pathStrictEqual(
                actualPath,
                expected[index],
                message ?? `Paths at index ${index} are not equal: ${actualPath} !== ${expected[index]} .`
            )
        })
    }
}

/**
 * Asserts that a sequence of text edits contains exactly the expected replacement texts.
 * Use this for formatter or fixer tests where edit ranges are tested separately.
 */
export function editTextsStrictEqual(edits: readonly { newText: string }[], expected: readonly string[]): void {
    assert.deepStrictEqual(edits.map(edit => edit.newText), expected)
}

/**
 * Asserts that an extension log contains a message or regular-expression match.
 * Use this after the code under test is expected to emit an extension log.
 */
export function hasLogStrict(message: string | RegExp): void {
    assert.ok(hasLog(message), '\n' + log.all().join('\n'))
}

/**
 * Asserts that an extension log does not contain a message or regular-expression match.
 * Use this for negative logging behavior.
 */
export function notHasLogStrict(message: string | RegExp): void {
    assert.ok(!hasLog(message), '\n' + log.all().join('\n'))
}

/**
 * Asserts that the compiler log contains a message or regular-expression match.
 * Use this for diagnostics emitted through the compiler log channel.
 */
export function hasCompilerLogStrict(message: string | RegExp): void {
    assert.ok(hasCompilerLog(message), '\n' + compilerLogs().join('\n'))
}

assert.listStrictEqual = listStrictEqual
assert.pathStrictEqual = pathStrictEqual
assert.pathNotStrictEqual = pathNotStrictEqual
assert.pathListStrictEqual = pathListStrictEqual
assert.hasLog = hasLogStrict
assert.notHasLog = notHasLogStrict
assert.hasCompilerLog = hasCompilerLogStrict
