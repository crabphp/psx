import { QueryProblem, QueryRedirect, RequestFailure } from './protocol.js';
import type { BoundOperation, Runtime } from './runtime.js';
import type { QueryClient, QueryError, QueryKey, QueryOptions, QueryState } from './types.js';

interface Entry {
    key: QueryKey;
    text: string;
    bound: BoundOperation;
    input: unknown;
    data: unknown;
    has: boolean;
    error: QueryError | null;
    fetching: boolean;
    /** Raised by each invalidation: an answer asked for before it is not this entry's any more. */
    generation: number;
    stale: boolean;
    updated: number;
    tags: readonly string[];
    bytes: number;
    used: number;
    /** Who is told of a change, and whether each wants the data read: a disabled reader only watches. */
    listeners: Map<() => void, boolean>;
    /** True while a request somebody asked for by refetch() is in flight: it is theirs, whoever watches. */
    explicit: boolean;
    promise: Promise<unknown> | null;
    controller: AbortController | null;
    timer: ReturnType<typeof setTimeout> | null;
    snapshot: QueryState<unknown> | null;
}

/**
 * The data of the queries the page's components read, by key. It is private to this document and
 * to who is signed in: it is not kept past either, not shared with another tab, and bounded.
 */
export class QueryCache implements QueryClient {
    private entries = new Map<string, Entry>();
    private clock = 0;

    constructor(private readonly runtime: Runtime) {}

    entry(bound: BoundOperation, input: unknown, initial?: unknown): Entry {
        const key = this.runtime.key(bound, input);
        const text = JSON.stringify(key);
        let entry = this.entries.get(text);
        if (entry === undefined) {
            entry = {
                key,
                text,
                bound,
                input,
                data: initial,
                has: initial !== undefined,
                error: null,
                fetching: false,
                generation: 0,
                // What a loader gave is shown at once and asked for again: it says nothing of how fresh it is.
                stale: true,
                updated: 0,
                tags: [],
                bytes: initial === undefined ? 0 : size(initial),
                used: ++this.clock,
                listeners: new Map(),
                explicit: false,
                promise: null,
                controller: null,
                timer: null,
                snapshot: null,
            };
            this.entries.set(text, entry);
            this.evict();
        }
        entry.used = ++this.clock;
        return entry;
    }

    snapshot<O>(entry: Entry): QueryState<O> {
        if (entry.snapshot === null) {
            entry.snapshot = Object.freeze({
                status: entry.has ? 'success' : entry.error !== null ? 'error' : 'pending',
                data: entry.data,
                error: entry.error,
                isFetching: entry.fetching,
                refetch: () => this.refetch(entry),
            });
        }
        return entry.snapshot as QueryState<O>;
    }

    subscribe(entry: Entry, listener: () => void, options: QueryOptions<unknown>): () => void {
        const enabled = options.enabled !== false;
        entry.listeners.set(listener, enabled);
        if (entry.timer !== null) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        const fresh = entry.has && !entry.stale && Date.now() - entry.updated < (options.staleTime ?? 0);
        if (enabled && !fresh && !entry.fetching) {
            this.fetch(entry).catch(() => undefined);
        }
        return () => {
            if (!entry.listeners.delete(listener)) {
                return;
            }
            if (entry.listeners.size === 0) {
                // Nobody watches it: the entry is dropped in a while.
                entry.timer = setTimeout(() => {
                    entry.timer = null;
                    if (entry.listeners.size === 0) {
                        this.release(entry);
                        // Only itself: an entry made for the same query since is another's.
                        if (this.entries.get(entry.text) === entry) {
                            this.entries.delete(entry.text);
                        }
                    }
                }, this.runtime.limits.queryCacheGcSeconds * 1000);
            }
            if (entry.promise !== null && !this.wanted(entry)) {
                // The request may have lost its last reader. That is decided once this turn is over:
                // a reader that leaves and returns at once, as React's effects do, keeps the request.
                queueMicrotask(() => {
                    if (!this.wanted(entry)) {
                        this.release(entry);
                    }
                });
            }
        };
    }

    /** Reads again because somebody asked: the request is theirs and is not let go when readers leave. */
    refetch<O>(entry: Entry): Promise<O> {
        entry.explicit = true;
        return this.fetch<O>(entry);
    }

    /** Whether anyone wants this entry's data read: an enabled reader, or a refetch() in flight. */
    private wanted(entry: Entry): boolean {
        if (entry.explicit) {
            return true;
        }
        for (const enabled of entry.listeners.values()) {
            if (enabled) {
                return true;
            }
        }
        return false;
    }

    /**
     * Lets go of a request nobody wants. It is cancelled and no longer the entry's: whatever its
     * transport answers later, and whenever, changes nothing, and the next reader starts its own.
     */
    private release(entry: Entry): void {
        if (entry.promise === null) {
            return;
        }
        const controller = entry.controller;
        entry.promise = null;
        entry.controller = null;
        entry.fetching = false;
        entry.explicit = false;
        controller?.abort();
        this.changed(entry);
    }

    fetch<O>(entry: Entry): Promise<O> {
        if (entry.promise !== null) {
            return entry.promise as Promise<O>;
        }
        const generation = entry.generation;
        const epoch = this.runtime.epoch;
        const controller = new AbortController();
        entry.controller = controller;
        entry.fetching = true;
        this.changed(entry);
        const promise = this.runtime.read<O>(entry.bound, entry.input, { signal: controller.signal }).then(
            ({ data, tags }) => {
                if (entry.promise !== promise) {
                    return data;
                }
                const explicit = entry.explicit;
                entry.promise = null;
                entry.controller = null;
                entry.fetching = false;
                entry.explicit = false;
                if (epoch !== this.runtime.epoch) {
                    // It was asked as someone who is no longer signed in: it is nobody's.
                    this.changed(entry);
                    return data;
                }
                if (generation !== entry.generation) {
                    // It was asked before what it reads changed: it is not kept. Whoever still wants
                    // the data has it asked again; a reader that is disabled does not.
                    if (explicit || this.wanted(entry)) {
                        entry.explicit = explicit;
                        return this.fetch<O>(entry);
                    }
                    this.changed(entry);
                    return data;
                }
                entry.data = data;
                entry.has = true;
                entry.error = null;
                entry.stale = false;
                entry.updated = Date.now();
                entry.tags = tags;
                entry.bytes = size(data);
                this.changed(entry);
                this.evict();
                return data;
            },
            (error: unknown) => {
                if (entry.promise === promise) {
                    entry.promise = null;
                    entry.controller = null;
                    entry.fetching = false;
                    entry.explicit = false;
                    const cancelled = error instanceof RequestFailure && error.kind === 'aborted';
                    if (
                        !cancelled &&
                        (error instanceof QueryProblem ||
                            error instanceof QueryRedirect ||
                            error instanceof RequestFailure)
                    ) {
                        // What was shown stays shown; the error says the refresh failed.
                        entry.error = error;
                    }
                    this.changed(entry);
                }
                throw error;
            },
        );
        entry.promise = promise;
        return promise;
    }

    async invalidate(filter?: { key?: QueryKey; tags?: readonly string[] }): Promise<void> {
        const text = filter?.key === undefined ? null : JSON.stringify(filter.key);
        const waits: Promise<unknown>[] = [];
        for (const entry of this.entries.values()) {
            const matches =
                (text === null || entry.text === text) &&
                (filter?.tags === undefined || filter.tags.some(tag => entry.tags.includes(tag)));
            if (!matches) {
                continue;
            }
            entry.generation++;
            entry.stale = true;
            if (this.wanted(entry)) {
                waits.push((entry.promise ?? this.fetch(entry)).catch(() => undefined));
            } else if (entry.promise !== null) {
                waits.push(entry.promise.catch(() => undefined));
            }
        }
        await Promise.all(waits);
    }

    clear(): void {
        for (const entry of this.entries.values()) {
            entry.controller?.abort();
            if (entry.timer !== null) {
                clearTimeout(entry.timer);
            }
            entry.promise = null;
            entry.controller = null;
            entry.explicit = false;
            entry.timer = null;
            entry.data = undefined;
            entry.has = false;
            entry.error = null;
            entry.fetching = false;
            entry.generation++;
            this.changed(entry);
        }
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }

    private changed(entry: Entry): void {
        entry.snapshot = null;
        for (const listener of [...entry.listeners.keys()]) {
            listener();
        }
    }

    /** Drops what nobody reads, oldest first, while there is more than the cache may hold. */
    private evict(): void {
        const limits = this.runtime.limits;
        let bytes = 0;
        for (const entry of this.entries.values()) {
            bytes += entry.bytes;
        }
        if (this.entries.size <= limits.queryCacheEntries && bytes <= limits.queryCacheBytes) {
            return;
        }
        const idle = [...this.entries.values()]
            .filter(entry => entry.listeners.size === 0)
            .sort((a, b) => a.used - b.used);
        for (const entry of idle) {
            if (this.entries.size <= limits.queryCacheEntries && bytes <= limits.queryCacheBytes) {
                break;
            }
            this.entries.delete(entry.text);
            bytes -= entry.bytes;
            if (entry.timer !== null) {
                // It is gone already: there is nothing left to wait for.
                clearTimeout(entry.timer);
                entry.timer = null;
            }
        }
    }
}

function size(value: unknown): number {
    try {
        return JSON.stringify(value)?.length ?? 0;
    } catch {
        return 0;
    }
}

export type { Entry as QueryEntry };
