import {
    activeRuntime,
    buildPath,
    encodeQuery,
    runtimeOf,
    type BoundOperation,
    type Runtime,
} from './runtime.js';
import { boundOperation, remember } from './bound.js';
import type {
    Action,
    ActionOf,
    ActionOptions,
    FormCapable,
    Manifest,
    Query,
    ReadOptions,
    RouteReference,
    RouteScope,
    ScopedAction,
    ScopedQuery,
    Segment,
} from './types.js';

export type { Manifest } from './types.js';

let installed: Manifest | null = null;

/** Gives the runtime the build's manifest. The Vite plugin calls it from the entry; nobody else does. */
export function install(manifest: Manifest): void {
    installed = manifest;
}

export function installedManifest(): Manifest {
    if (installed === null) {
        throw new Error(
            'PSX has no manifest: build the entry with psx() in vite.config.ts, started by `php cua dev` or `php cua psx:build`.',
        );
    }
    return installed;
}

/** One callable for each scope a descriptor is bound at: the same scope gives the same function. */
function stable<T extends object>(make: (scope: RouteScope) => T): (scope: RouteScope) => T {
    const made = new WeakMap<object, T>();
    return scope => {
        let bound = made.get(scope);
        if (bound === undefined) {
            bound = make(scope);
            made.set(scope, bound);
        }
        return bound;
    };
}

function boundQuery<I, O>(bound: BoundOperation): Query<I, O> {
    const call = ((input: I, options?: ReadOptions) =>
        bound.runtime.read<O>(bound, input, options).then(answer => answer.data)) as Query<I, O>;
    call.key = (input: I) => bound.runtime.key(bound, input);
    remember(call, bound);
    return call;
}

function boundAction<I, O>(bound: BoundOperation): Action<I, O> & FormCapable<O> {
    const call = ((input: I, options?: ActionOptions) =>
        bound.runtime.act<O>(bound, { json: input }, options)) as Action<I, O> & FormCapable<O>;
    call.form = (input: FormData, options?: ActionOptions) =>
        bound.runtime.act<O>(bound, { form: input }, options);
    return call;
}

/** The scope of a service mounted once on a path without parameters, of the runtime that is running. */
function only(runtime: Runtime, mount: string): RouteScope {
    const service = runtime.manifest.services[mount];
    if (service === undefined) {
        throw new TypeError(`There is no service "${mount}" in this build.`);
    }
    return serviceScope(runtime, mount, service.path, {});
}

const serviceScopes = new WeakMap<Runtime, Map<string, RouteScope>>();

function serviceScope(
    runtime: Runtime,
    name: string,
    path: readonly Segment[],
    params: Record<string, string | number>,
): RouteScope {
    const href = buildPath(path, params);
    let known = serviceScopes.get(runtime);
    if (known === undefined) {
        known = new Map();
        serviceScopes.set(runtime, known);
    }
    // The same service at the same address is the same scope, so what is bound at it is stable.
    const key = `${name} ${href}`;
    let scope = known.get(key);
    if (scope === undefined) {
        const text: Record<string, string> = {};
        for (const [parameter, value] of Object.entries(params)) {
            text[parameter] = String(value);
        }
        scope = runtime.scope({ routeId: name, mountId: name, href, params: text }, null);
        known.set(key, scope);
    }
    return scope;
}

export const query = {
    /** A query of a page, a layout or a service with a scope: bound with `.at(scope)`. */
    scoped<M extends string, I, O>(module: string, method: string): ScopedQuery<M, I, O> {
        const at = stable(scope => boundQuery<I, O>(runtimeOf(scope).bind(module, method, scope)));
        return Object.freeze({ at: (scope: RouteScope<M>) => at(scope) });
    },

    /** A query of a service mounted once, without path parameters: called as it is. */
    direct<M extends string, I, O>(module: string, method: string, mount: M): Query<I, O> {
        const bound = (): Query<I, O> => {
            const runtime = activeRuntime();
            const scope = only(runtime, mount);
            return made(scope);
        };
        const made = stable(scope => boundQuery<I, O>(runtimeOf(scope).bind(module, method, scope)));
        const call = ((input: I, options?: ReadOptions) => bound()(input, options)) as Query<I, O>;
        call.key = (input: I) => bound().key(input);
        // useQuery reads which operation it is when it renders, when the runtime is known.
        remember(call, () => boundOperation(bound())!);
        return call;
    },
};

export const action = {
    /** An action of a page, a layout or a service with a scope: bound with `.at(scope)`. */
    scoped<M extends string, I, O, Mode extends 'both' | 'json' | 'form'>(
        module: string,
        method: string,
    ): ScopedAction<M, ActionOf<I, O, Mode>> {
        const at = stable(scope => boundAction<I, O>(runtimeOf(scope).bind(module, method, scope)));
        return Object.freeze({ at: (scope: RouteScope<M>) => at(scope) as unknown as ActionOf<I, O, Mode> });
    },

    /** An action of a service mounted once, without path parameters: called as it is. */
    direct<M extends string, I, O, Mode extends 'both' | 'json' | 'form'>(
        module: string,
        method: string,
        mount: M,
    ): ActionOf<I, O, Mode> {
        const made = stable(scope => boundAction<I, O>(runtimeOf(scope).bind(module, method, scope)));
        const bound = (): Action<I, O> & FormCapable<O> => made(only(activeRuntime(), mount));
        const call = ((input: I, options?: ActionOptions) => bound()(input, options)) as Action<I, O> &
            FormCapable<O>;
        call.form = (input: FormData, options?: ActionOptions) => bound().form(input, options);
        return call as unknown as ActionOf<I, O, Mode>;
    },
};

type QueryInput = Record<string, unknown>;

/**
 * A named page's address builder: `routes.posts.edit({ id: 7 }, { tab: 'history' })`. The path's
 * parameters are encoded, never joined as text; the query is what the page's loaders declare.
 */
export function route<P extends Record<string, string | number>, Q extends QueryInput>(
    name: string,
    segments: readonly Segment[],
): {} extends P ? (params?: P, query?: Q) => RouteReference : (params: P, query?: Q) => RouteReference {
    return ((params?: P, query?: Q): RouteReference => {
        const search = query === undefined ? '' : encodeQuery(query);
        return Object.freeze({
            route: name,
            href: buildPath(segments, params ?? {}) + (search === '' ? '' : `?${search}`),
        });
    }) as never;
}

/** A named service's scope maker: `services.orgPeople.scope({ org: 'acme' })`. */
export function service<P extends Record<string, string | number>, N extends string>(
    name: N,
    segments: readonly Segment[],
): { scope(params: P): RouteScope<N> } {
    return Object.freeze({
        scope: (params: P) => serviceScope(activeRuntime(), name, segments, params) as RouteScope<N>,
    });
}
