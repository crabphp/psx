import type { BoundOperation } from './runtime.js';

/** Which operation a generated query is, where: what useQuery reads from the function it is given. */
const bound = new WeakMap<object, BoundOperation>();

/** The same, for a query called without a scope, which is bound once the runtime is known. */
const lazy = new WeakMap<object, () => BoundOperation>();

export function remember(query: object, operation: BoundOperation | (() => BoundOperation)): void {
    if (typeof operation === 'function') {
        lazy.set(query, operation);
    } else {
        bound.set(query, operation);
    }
}

export function boundOperation(query: object): BoundOperation | undefined {
    return bound.get(query) ?? lazy.get(query)?.();
}
