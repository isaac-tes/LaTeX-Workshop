import { lw } from '../lw'
import { Cache } from './cache/cache'

export const cache = new Cache()

// These process-wide listeners stay in the facade because Watcher does not
// return disposables; registering them in Cache would leak callbacks whenever
// tests construct an isolated instance.
lw.watcher.src.onChange(uri => Cache.handleWatchedFileChange(cache, uri))
lw.watcher.src.onDelete(uri => Cache.handleWatchedFileDelete(cache, uri))
lw.onDispose({ dispose: () => cache.reset() })
