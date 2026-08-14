import type { FileCache } from '../../types'

/**
 * Owns the mutable data for one Cache instance without performing I/O or
 * triggering application side effects.
 */
export class CacheStore {
    private readonly caches = new Map<string, FileCache>()
    private readonly inFlight = new Map<string, Promise<void>>()

    get(filePath: string): FileCache | undefined {
        return this.caches.get(filePath)
    }

    set(filePath: string, fileCache: FileCache): void {
        this.caches.set(filePath, fileCache)
    }

    delete(filePath: string): boolean {
        return this.caches.delete(filePath)
    }

    clear(): void {
        this.caches.clear()
    }

    paths(): string[] {
        return Array.from(this.caches.keys())
    }

    get promises(): Map<string, Promise<void>> {
        return this.inFlight
    }
}
