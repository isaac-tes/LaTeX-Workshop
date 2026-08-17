import * as path from 'path'

import type { FileCache } from '../../types'

/**
 * Owns the mutable data for one Cache instance without performing I/O or
 * triggering application side effects.
 */
export class CacheStore {
    private readonly caches = new Map<string, FileCache>()
    private readonly inFlight = new Map<string, Promise<void>>()

    /**
     * Produces the cache subsystem's identity key without rewriting the path
     * retained in FileCache for diagnostics. Windows drive paths are normalized
     * with win32 rules on every host so tests and remote workflows agree.
     */
    static normalizePath(filePath: string): string {
        const normalized = /^[A-Za-z]:[\\/]/.test(filePath) ? path.win32.normalize(filePath) : path.normalize(filePath)
        return normalized.replace(/^([A-Z]):/, drive => drive.toLowerCase())
    }

    get(filePath: string): FileCache | undefined {
        return this.caches.get(CacheStore.normalizePath(filePath))
    }

    set(filePath: string, fileCache: FileCache): void {
        this.caches.set(CacheStore.normalizePath(filePath), fileCache)
    }

    delete(filePath: string): boolean {
        return this.caches.delete(CacheStore.normalizePath(filePath))
    }

    clear(): void {
        this.caches.clear()
    }

    paths(): string[] {
        return Array.from(this.caches.values(), fileCache => fileCache.filePath)
    }

    getInFlight(filePath: string): Promise<void> | undefined {
        return this.inFlight.get(CacheStore.normalizePath(filePath))
    }

    setInFlight(filePath: string, task: Promise<void>): void {
        this.inFlight.set(CacheStore.normalizePath(filePath), task)
    }

    deleteInFlight(filePath: string): boolean {
        return this.inFlight.delete(CacheStore.normalizePath(filePath))
    }

    get promises(): Map<string, Promise<void>> {
        return this.inFlight
    }
}
