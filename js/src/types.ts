import type { ComponentType, ReactNode } from 'react';

export type JsonValue =
    null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** What a refusal or an expected failure says, and nothing else of the server. */
export interface PublicProblem {
    readonly status: number;
    readonly code: string;
    readonly message: string;
    readonly fields: Readonly<Record<string, readonly string[]>>;
    readonly query: Readonly<Record<string, readonly string[]>>;
    readonly path: Readonly<Record<string, readonly string[]>>;
    readonly requestId?: string;
    readonly retryAfter?: number;
    readonly loginUrl?: string;
}

export interface RedirectTarget {
    readonly href: string;
    readonly mode: 'internal' | 'document';
    readonly replace: boolean;
}

/**
 * Which page a scope was made on: an old page's callbacks cannot act as the new page. It names the
 * history entry, the sign-in the page was loaded under, and the navigation intent that was the
 * latest when it was made: every later intent, whether it replaced the address, was held, or
 * failed, leaves it behind.
 */
export interface NavigationOrigin {
    readonly entryKey: string;
    readonly epoch: number;
    readonly intent: number;
}

declare const mount: unique symbol;

/**
 * Where a query or an action is called: a page's, a layout's or a service's mount, and the path
 * parameters it had. It is frozen when made and holds no credential: the browser's own are used
 * when a call is sent.
 */
export interface RouteScope<M extends string = string> {
    readonly routeId: string;
    readonly mountId: M;
    readonly href: string;
    readonly params: Readonly<Record<string, string>>;
    readonly navigation: NavigationOrigin | null;
    readonly [mount]?: M;
}

export interface PageProps<D, M extends string = string> {
    readonly data: Readonly<D>;
    readonly scope: RouteScope<M>;
}

export interface LayoutProps<D, M extends string = string> extends PageProps<D, M> {
    readonly children: ReactNode;
}

export type ReadOptions = { signal?: AbortSignal };
export type ActionOptions = { signal?: AbortSignal };

/** What identifies a query's cached data. Made by `.key(input)`, never by hand. */
export type QueryKey = readonly [
    'psx',
    build: string,
    schema: string,
    operation: string,
    scope: string,
    input: string,
    epoch: number,
];

export interface Query<I, O> {
    (input: I, options?: ReadOptions): Promise<O>;
    key(input: I): QueryKey;
}

export interface Action<I, O> {
    (input: I, options?: ActionOptions): Promise<ActionResult<O>>;
}

export interface FormCapable<O> {
    form(input: FormData, options?: ActionOptions): Promise<ActionResult<O>>;
}

export interface ScopedQuery<M extends string, I, O> {
    at(scope: RouteScope<M>): Query<I, O>;
}

export interface ScopedAction<M extends string, A> {
    at(scope: RouteScope<M>): A;
}

/** What an action can be called with: an object, a form, or either. A file goes by a form alone. */
export type ActionOf<I, O, Mode extends 'both' | 'json' | 'form'> = Mode extends 'both'
    ? Action<I, O> & FormCapable<O>
    : Mode extends 'json'
      ? Action<I, O>
      : FormCapable<O>;

export interface AuthTransitionState {
    readonly status: 'reconciled' | 'document-required';
    readonly origin: NavigationOrigin | null;
}

export type ActionResult<O> =
    | {
          readonly ok: true;
          readonly data: O;
          readonly redirect?: RedirectTarget;
          readonly auth?: AuthTransitionState;
      }
    | { readonly ok: false; readonly problem: PublicProblem };

/** A route to go to: an address of this site, or what a builder of `@psx/routes` made. */
export type RouteTarget = string | RouteReference;

export interface RouteReference {
    readonly route: string;
    readonly href: string;
}

export interface NavigationOptions {
    replace?: boolean;
    scroll?: 'auto' | 'preserve';
    state?: JsonValue;
    ifCurrent?: NavigationOrigin;
}

export type NavigationResult =
    | { status: 'committed'; href: string }
    | { status: 'superseded' }
    | { status: 'blocked' }
    | { status: 'document'; href: string }
    | { status: 'failed'; error: NavigationFailure };

export interface NavigationFailure {
    readonly href: string;
    readonly failure: import('./protocol.js').RequestFailure;
    retry(): Promise<NavigationResult>;
    dismiss(): void;
}

export interface NavigationIntent {
    readonly href: string;
    readonly type: 'push' | 'replace' | 'pop';
}

export interface NavigationBlocker {
    getSnapshot(): NavigationIntent | null;
    subscribe(listener: () => void): () => void;
    proceed(): Promise<NavigationResult>;
    reset(): void;
    dispose(): void;
}

export interface Router {
    readonly location: { readonly href: string; readonly entryKey: string; readonly state: JsonValue | null };
    readonly pending: null | { readonly href: string };
    readonly navigationError: NavigationFailure | null;
    navigate(to: RouteTarget, options?: NavigationOptions): Promise<NavigationResult>;
    revalidate(): Promise<void>;
    prefetch(to: RouteTarget): Promise<void>;
    block(test: (next: NavigationIntent) => boolean): NavigationBlocker;
}

export interface QueryOptions<O> {
    enabled?: boolean;
    staleTime?: number;
    initialData?: O;
}

export type QueryError =
    | import('./protocol.js').QueryProblem
    | import('./protocol.js').QueryRedirect
    | import('./protocol.js').RequestFailure;

export interface QueryState<O> {
    readonly status: 'pending' | 'success' | 'error';
    readonly data: O | undefined;
    readonly error: QueryError | null;
    readonly isFetching: boolean;
    refetch(): Promise<O>;
}

export interface QueryClient {
    invalidate(filter?: { key?: QueryKey; tags?: readonly string[] }): Promise<void>;
    clear(): void;
}

export interface RouteErrorProps {
    problem: PublicProblem;
    /** Loads the page again. It repeats a read, never the action that failed. */
    retry(): Promise<void>;
}

export interface RenderErrorProps {
    error: Error;
    reset(): void;
}

/** What a page's or a layout's module exports. */
export interface PageModule {
    default: ComponentType<any>;
    Pending?: ComponentType;
    ErrorBoundary?: ComponentType<RenderErrorProps>;
    RouteError?: ComponentType<RouteErrorProps>;
}

export type Segment = { text: string } | { name: string; expression: string | null };

export type Shape =
    | { k: 'string' | 'int' | 'float' | 'bool' | 'null' | 'date' }
    | { k: 'enum'; values: readonly (string | number)[] }
    | { k: 'list' | 'map' | 'nullable'; of: Shape }
    | { k: 'object'; props: Readonly<Record<string, Shape>> };

/** What the build tells the runtime of the application. The Vite plugin gives it; nobody writes it. */
export interface Manifest {
    protocol: number;
    navigation: string;
    modules: Record<string, () => Promise<unknown>>;
    wrapper: ComponentType<{ children?: ReactNode }> | null;
    routes: Record<
        string,
        {
            path: readonly Segment[];
            schema: string;
            query: readonly string[];
            nodes: readonly { mount: string; module: string; layout: string | null; shape: unknown }[];
        }
    >;
    services: Record<string, { path: readonly Segment[] }>;
    operations: Record<
        string,
        Record<
            string,
            {
                role: string;
                mode: string;
                auth: boolean;
                shape: unknown;
                mounts: Record<string, { id: string; schema: string; path: readonly Segment[] }>;
            }
        >
    >;
}

export interface AuthSnapshot {
    readonly context: string;
    readonly revision: string;
    readonly partition: string;
}

export interface Limits {
    queryCacheEntries: number;
    queryCacheBytes: number;
    queryCacheGcSeconds: number;
    prefetchTtlSeconds: number;
    readRetries: number;
    authReconcileSeconds: number;
    maxResponseBytes: number;
    maxDepth: number;
}

export const defaultLimits: Limits = {
    queryCacheEntries: 200,
    queryCacheBytes: 8 * 1024 * 1024,
    queryCacheGcSeconds: 300,
    prefetchTtlSeconds: 15,
    readRetries: 0,
    authReconcileSeconds: 5,
    maxResponseBytes: 2 * 1024 * 1024,
    maxDepth: 32,
};

export interface WireNode {
    mount: string;
    module: string;
    key: string;
    data: unknown;
    scope: { routeId: string; mountId: string; href: string; params: Record<string, string> };
}

export interface WireHead {
    title: string | null;
    meta: Record<string, Record<string, string>>;
    links: Record<string, Record<string, string>>;
}

export interface PageEnvelope {
    protocol: 1;
    build: string;
    kind: 'page';
    requestId?: string;
    route: { id: string; href: string };
    nodes: WireNode[];
    head: WireHead;
    tags: string[];
    auth?: AuthSnapshot;
}

export interface ProblemEnvelope {
    protocol: 1;
    kind: 'problem';
    respondingBuild: string;
    requestedBuild: string | null;
    execution: 'entered' | 'not-entered';
    problem: PublicProblem;
    pageError?: Omit<PageEnvelope, 'protocol' | 'kind'>;
}

export interface Bootstrap {
    envelope: PageEnvelope | ProblemEnvelope;
    rendering: 'client' | 'server';
    limits: Limits;
    development: boolean;
}
