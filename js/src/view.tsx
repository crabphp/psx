import {
    Component,
    createContext,
    createElement,
    useContext,
    useLayoutEffect,
    useMemo,
    useSyncExternalStore,
    type AnchorHTMLAttributes,
    type ComponentType,
    type MouseEvent,
    type ReactElement,
    type ReactNode,
} from 'react';
import { boundOperation } from './bound.js';
import type { QueryEntry } from './queries.js';
import type { PageState, RouterSnapshot } from './router.js';
import type { Runtime } from './runtime.js';
import type {
    PublicProblem,
    Query,
    QueryClient,
    QueryOptions,
    QueryState,
    RenderErrorProps,
    RouteErrorProps,
    Router,
    RouteTarget,
} from './types.js';

export const RuntimeContext = createContext<Runtime | null>(null);

function useRuntime(): Runtime {
    const runtime = useContext(RuntimeContext);
    if (runtime === null) {
        throw new Error('This component is rendered outside the application start() mounts.');
    }
    return runtime;
}

/**
 * The router, as of this render. Its location, pending navigation and navigation error are what
 * was true when the component rendered, and it renders again when they change; navigate() and the
 * rest are the same functions every time.
 */
export function useRouter(): Router {
    const core = useRuntime().router;
    const snapshot = useSyncExternalStore(core.subscribe, core.getSnapshot, core.getServerSnapshot);
    return useMemo(
        () => ({
            location: snapshot.location,
            pending: snapshot.pending,
            navigationError: snapshot.navigationError,
            navigate: core.navigate,
            revalidate: core.revalidate,
            prefetch: core.prefetch,
            block: core.block,
        }),
        [core, snapshot.location, snapshot.pending, snapshot.navigationError],
    );
}

export function useQueryClient(): QueryClient {
    return useRuntime().queries;
}

const never = (): (() => void) => () => undefined;

/**
 * Reads a query and keeps what it gave. The request starts once the component is on screen, never
 * while it renders; components asking the same thing share one request and one answer.
 */
export function useQuery<I, O>(query: Query<I, O>, input: I, options: QueryOptions<O> = {}): QueryState<O> {
    const runtime = useRuntime();
    const bound = boundOperation(query);
    if (bound === undefined) {
        throw new TypeError("useQuery takes a query PSX generated: $name.at(scope), or a service's $name.");
    }
    const { enabled, staleTime, initialData } = options;
    // The key is of the input's content: an object written anew each render is the same query.
    const text = JSON.stringify(runtime.key(bound, input));
    const entry: QueryEntry = useMemo(
        () => runtime.queries.entry(bound, input, initialData),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [runtime, text],
    );
    const subscribe = useMemo(
        () =>
            runtime.server
                ? never
                : (listener: () => void) =>
                      runtime.queries.subscribe(entry, listener, { enabled, staleTime }),
        [runtime, entry, enabled, staleTime],
    );
    const snapshot = (): QueryState<O> => runtime.queries.snapshot<O>(entry);
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
    href: RouteTarget;
    replace?: boolean;
    scroll?: 'auto' | 'preserve';
    prefetch?: 'none' | 'intent';
};

/**
 * A link: a real anchor, which the browser treats as one. A plain click navigates without leaving
 * the document; a click with a modifier, another button, a target or a download is the browser's.
 */
export function Link({
    href,
    replace,
    scroll,
    prefetch,
    onClick,
    onMouseEnter,
    onFocus,
    ...rest
}: LinkProps): ReactElement {
    const runtime = useRuntime();
    const address = typeof href === 'string' ? href : href.href;
    const intent = (): void => {
        if (prefetch === 'intent') {
            void runtime.router.prefetch(address).catch(() => undefined);
        }
    };
    return createElement('a', {
        ...rest,
        href: address,
        onMouseEnter: (event: MouseEvent<HTMLAnchorElement>) => {
            onMouseEnter?.(event);
            intent();
        },
        onFocus: (event: React.FocusEvent<HTMLAnchorElement>) => {
            onFocus?.(event);
            intent();
        },
        onClick: (event: MouseEvent<HTMLAnchorElement>) => {
            onClick?.(event);
            const anchor = event.currentTarget;
            if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                (anchor.target !== '' && anchor.target !== '_self') ||
                anchor.hasAttribute('download')
            ) {
                return;
            }
            let url: URL;
            try {
                url = new URL(anchor.href, location.href);
            } catch {
                return;
            }
            if (url.origin !== location.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
                return;
            }
            event.preventDefault();
            // The result is the router's to show; a failure is in router.navigationError, not thrown here.
            void runtime.router
                .navigate(url.pathname + url.search + url.hash, { replace, scroll })
                .catch(error => {
                    runtime.onError?.(error as Error, { kind: 'protocol', build: runtime.build });
                });
        },
    });
}

interface BoundaryProps {
    fallback: ComponentType<RenderErrorProps>;
    runtime: Runtime;
    children?: ReactNode;
}

/** A real error boundary around each page and layout; the module's ErrorBoundary export is what it shows. */
class Boundary extends Component<BoundaryProps, { error: Error | null }> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: unknown): { error: Error } {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }

    componentDidCatch(error: Error): void {
        this.props.runtime.onError?.(error, { kind: 'render', build: this.props.runtime.build });
    }

    render(): ReactNode {
        if (this.state.error !== null) {
            return createElement(this.props.fallback, {
                error: this.state.error,
                reset: () => this.setState({ error: null }),
            });
        }
        return this.props.children;
    }
}

function RenderFailed({ reset }: RenderErrorProps): ReactElement {
    return createElement(
        'div',
        { role: 'alert' },
        createElement('p', null, 'This part of the page could not be shown.'),
        createElement('button', { type: 'button', onClick: reset }, 'Try again'),
    );
}

function RouteFailed({ problem, retry }: RouteErrorProps): ReactElement {
    return createElement(
        'main',
        { role: 'alert' },
        createElement('h1', null, problem.status === 404 ? 'Not found' : 'This page could not be loaded'),
        createElement('p', null, problem.message),
        problem.loginUrl === undefined
            ? createElement('button', { type: 'button', onClick: () => void retry() }, 'Try again')
            : createElement('a', { href: problem.loginUrl }, 'Sign in'),
    );
}

function Reconciling({ required }: { required: boolean }): ReactElement {
    return createElement(
        'main',
        { role: 'status' },
        required
            ? createElement(
                  'p',
                  null,
                  'Who is signed in changed. ',
                  createElement(
                      'a',
                      { href: typeof location === 'undefined' ? '/' : location.href },
                      'Reload the page',
                  ),
              )
            : null,
    );
}

function NavigationFailed({ snapshot }: { snapshot: RouterSnapshot }): ReactElement | null {
    const error = snapshot.navigationError;
    if (error === null) {
        return null;
    }
    return createElement(
        'div',
        { role: 'alert', 'data-psx-navigation-error': '' },
        createElement('span', null, error.failure.message),
        ' ',
        createElement('button', { type: 'button', onClick: () => void error.retry() }, 'Try again'),
        ' ',
        createElement('button', { type: 'button', onClick: error.dismiss }, 'Dismiss'),
    );
}

function Committed({ page, runtime }: { page: PageState; runtime: Runtime }): null {
    useLayoutEffect(() => {
        runtime.router.committed(page);
        // Once for each navigation committed; a refresh of the same page keeps its commit.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page.commit]);
    return null;
}

/**
 * The page: each layout around the next, the page innermost, each keyed by what its state is kept
 * by. A layout whose key is the same across a navigation keeps its state and gets new props.
 */
export function PageView({
    runtime,
    errorSlot = true,
}: {
    runtime: Runtime;
    errorSlot?: boolean;
}): ReactElement | null {
    const snapshot = useSyncExternalStore(
        runtime.router.subscribe,
        runtime.router.getSnapshot,
        runtime.router.getServerSnapshot,
    );
    const page = snapshot.page;
    if (snapshot.reconciling) {
        return createElement(Reconciling, { required: snapshot.documentRequired });
    }
    if (page === null) {
        return null;
    }
    let tree: ReactNode = null;
    if (page.problem !== null) {
        const problem: PublicProblem = page.problem;
        tree = createElement(page.failed?.RouteError ?? RouteFailed, {
            problem,
            retry: runtime.router.revalidate,
        });
    }
    for (let index = page.nodes.length - 1; index >= 0; index--) {
        const node = page.nodes[index]!;
        const leaf = index === page.nodes.length - 1 && page.problem === null;
        tree = createElement(
            Boundary,
            { key: node.key, fallback: node.exports.ErrorBoundary ?? RenderFailed, runtime },
            createElement(
                node.exports.default,
                leaf
                    ? { data: node.data, scope: node.scope }
                    : { data: node.data, scope: node.scope, children: tree },
            ),
        );
    }
    let pending: ReactNode = null;
    if (snapshot.pending !== null) {
        for (let index = page.nodes.length - 1; index >= 0 && pending === null; index--) {
            const Pending = page.nodes[index]!.exports.Pending;
            pending = Pending === undefined ? null : createElement(Pending, { key: 'psx-pending' });
        }
    }
    return createElement(
        RuntimeContext.Provider,
        { value: runtime },
        errorSlot ? createElement(NavigationFailed, { snapshot }) : null,
        tree,
        pending,
        createElement(Committed, { page, runtime }),
    );
}

/** The whole application: the wrapper the build was given, around the page. */
export function App({ runtime }: { runtime: Runtime }): ReactElement {
    const Wrapper = runtime.manifest.wrapper;
    const view = createElement(PageView, { runtime });
    return createElement(
        RuntimeContext.Provider,
        { value: runtime },
        Wrapper === null ? view : createElement(Wrapper, null, view),
    );
}
