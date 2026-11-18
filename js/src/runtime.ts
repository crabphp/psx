import {
    exchange,
    QueryProblem,
    QueryRedirect,
    readRedirect,
    RequestFailure,
    type Transport,
} from './protocol.js';
import { QueryCache } from './queries.js';
import { RouterCore } from './router.js';
import { mismatch, plain } from './shapes.js';
import {
    defaultLimits,
    type ActionOptions,
    type ActionResult,
    type AuthSnapshot,
    type AuthTransitionState,
    type Limits,
    type Manifest,
    type NavigationOrigin,
    type QueryKey,
    type ReadOptions,
    type RouteScope,
    type Segment,
    type Shape,
} from './types.js';

type Operation = Manifest['operations'][string][string];

export interface BoundOperation {
    runtime: Runtime;
    module: string;
    method: string;
    scope: RouteScope;
    operation: Operation;
    mount: { id: string; schema: string; path: readonly Segment[] };
}

export interface RuntimeOptions {
    manifest: Manifest;
    build: string;
    transport?: Transport;
    limits?: Partial<Limits>;
    auth?: AuthSnapshot | null;
    /** True where React renders on the server: nothing is fetched and no history is touched. */
    server?: boolean;
    development?: boolean;
    /** Leaves the document for an address; the browser's own navigation unless a test says otherwise. */
    /** Leaves the document for an address; `replace` says it takes the place of the entry shown. */
    leave?: (href: string, replace: boolean) => void;
    onError?: (
        error: Error,
        context: { kind: 'render' | 'protocol' | 'hydration'; build: string; requestId?: string },
    ) => void;
}

/**
 * How an answer's account of who is signed in stands to what this page knows: "current" is the
 * same, "advanced" is the same person at a later revision, "stale" is the same person at an
 * earlier one, and "doubtful" is anything that leaves who is signed in an open question.
 */
export type Standing = 'current' | 'advanced' | 'stale' | 'doubtful';

/** An answer's snapshot of who is signed in, when it is one: its revision is a decimal number. */
export function readAuth(value: unknown): AuthSnapshot | null {
    return plain(value) &&
        typeof value.context === 'string' &&
        typeof value.revision === 'string' &&
        /^\d{1,64}$/.test(value.revision) &&
        typeof value.partition === 'string'
        ? { context: value.context, revision: value.revision, partition: value.partition }
        : null;
}

/** Revisions are numbers written in decimal: "10" is after "9". */
function order(revision: string, than: string): number {
    const a = BigInt(revision);
    const b = BigInt(than);
    return a < b ? -1 : a > b ? 1 : 0;
}

const scopes = new WeakMap<object, Runtime>();
let active: Runtime | null = null;

/** The runtime of the application in this document, for what is called without a scope. */
export function activeRuntime(): Runtime {
    if (active === null) {
        throw new Error('PSX is not started: call start() from the entry before anything calls the server.');
    }
    return active;
}

export function setActiveRuntime(runtime: Runtime | null): void {
    active = runtime;
}

export function runtimeOf(scope: RouteScope): Runtime {
    const runtime = scopes.get(scope);
    if (runtime === undefined) {
        throw new TypeError(
            'This is not a scope PSX made. Use the scope prop of a page or a layout, or services.<name>.scope(...).',
        );
    }
    return runtime;
}

/**
 * One application in one document: what it was built as, how it reaches its server, who it thinks
 * is signed in, and its router and query cache. Nothing in it is a credential.
 */
export class Runtime {
    readonly manifest: Manifest;
    readonly build: string;
    readonly transport: Transport;
    readonly limits: Limits;
    readonly server: boolean;
    readonly leave: (href: string, replace: boolean) => void;
    readonly development: boolean;
    readonly onError: RuntimeOptions['onError'];
    readonly queries: QueryCache;
    readonly router: RouterCore;

    /** Counts the changes of who is signed in that this page knows of. */
    epoch = 0;
    auth: AuthSnapshot | null;
    /**
     * The action that is changing who is signed in, while it is in flight; null otherwise. It is
     * the action's own token: only the action that set it clears it, so one that ends late cannot
     * open writes that a later one closed.
     */
    private transition: object | null = null;
    private channel: BroadcastChannel | null = null;
    private disposed = false;

    constructor(options: RuntimeOptions) {
        this.manifest = options.manifest;
        this.build = options.build;
        this.limits = { ...defaultLimits, ...options.limits };
        this.leave =
            options.leave ??
            ((href, replace) => (replace ? window.location.replace(href) : window.location.assign(href)));
        this.server = options.server === true;
        this.development = options.development === true;
        this.onError = options.onError;
        this.auth = options.auth == null ? null : readAuth(options.auth);
        this.transport =
            options.transport ??
            ((url, init) => {
                if (this.server) {
                    return Promise.reject(
                        new Error('Nothing is fetched while a page is rendered on the server.'),
                    );
                }
                return fetch(url, init);
            });
        this.queries = new QueryCache(this);
        this.router = new RouterCore(this);
        if (!this.server && typeof BroadcastChannel !== 'undefined') {
            this.channel = new BroadcastChannel('psx-auth');
            // Another tab signed in or out: what this one holds may be someone else's now.
            this.channel.onmessage = () => void this.authChanged(false);
        }
    }

    /** A frozen scope this runtime knows as its own. */
    scope<M extends string>(
        wire: { routeId: string; mountId: string; href: string; params: Record<string, string> },
        navigation: NavigationOrigin | null,
    ): RouteScope<M> {
        const scope = Object.freeze({
            routeId: wire.routeId,
            mountId: wire.mountId as M,
            href: wire.href,
            params: Object.freeze({ ...wire.params }),
            navigation: navigation === null ? null : Object.freeze({ ...navigation }),
        }) as RouteScope<M>;
        scopes.set(scope, this);
        return scope;
    }

    /** The operation of a module as it is mounted where a scope is; a scope of another mount is refused. */
    bind(module: string, method: string, scope: RouteScope): BoundOperation {
        const operation = this.manifest.operations[module]?.[method];
        const mount = operation?.mounts[scope.mountId];
        if (operation === undefined || mount === undefined) {
            throw new TypeError(
                `$${method} is not mounted at "${scope.mountId}". Give it the scope of the page, layout or service it belongs to.`,
            );
        }
        return { runtime: this, module, method, scope, operation, mount };
    }

    key(bound: BoundOperation, input: unknown): QueryKey {
        return Object.freeze([
            'psx',
            this.build,
            bound.mount.schema,
            bound.mount.id,
            bound.scope.href,
            canonical(input),
            this.epoch,
        ]) as QueryKey;
    }

    /** Calls a query: its data, or a QueryProblem, a QueryRedirect or a RequestFailure thrown. */
    async read<O>(
        bound: BoundOperation,
        input: unknown,
        options?: ReadOptions,
    ): Promise<{ data: O; tags: string[] }> {
        let query: string;
        try {
            query = encodeQuery(input);
        } catch (error) {
            throw new RequestFailure('input', (error as Error).message, 'not-sent');
        }
        const url = buildPath(bound.mount.path, bound.scope.params) + (query === '' ? '' : `?${query}`);
        const retries = Math.min(2, this.limits.readRetries);
        const epoch = this.epoch;
        for (let attempt = 0; ; attempt++) {
            try {
                const answer = await exchange({
                    transport: this.transport,
                    build: this.build,
                    maxBytes: this.limits.maxResponseBytes,
                    method: 'GET',
                    url,
                    schema: bound.mount.schema,
                    expects: 'query',
                    signal: options?.signal,
                });
                if (answer.kind === 'problem') {
                    throw new QueryProblem(answer.problem);
                }
                if (answer.kind === 'redirect') {
                    throw new QueryRedirect(answer.target);
                }
                const data = answer.envelope.data;
                this.conforms(bound.operation.shape as Shape, data, false);
                if (epoch !== this.epoch) {
                    // It was asked as whoever was signed in then: it is nobody's now.
                    throw new RequestFailure(
                        'auth',
                        'Who is signed in changed while this was read. Read it again.',
                        'rejected',
                    );
                }
                const standing = this.witness(answer.envelope.auth);
                if (standing === 'stale' || standing === 'doubtful') {
                    throw new RequestFailure(
                        'auth',
                        standing === 'stale'
                            ? 'This answer is older than what the page already knows. Read it again.'
                            : 'Who is signed in changed. The page is being loaded again.',
                        'rejected',
                    );
                }
                const tags = Array.isArray(answer.envelope.tags)
                    ? answer.envelope.tags.filter(tag => typeof tag === 'string')
                    : [];
                return { data: data as O, tags };
            } catch (error) {
                // Only what never reached an answer is tried again, and only when the application asked for it.
                const again =
                    error instanceof RequestFailure &&
                    (error.kind === 'network' || (error.kind === 'server' && error.status === 503)) &&
                    attempt < retries &&
                    !options?.signal?.aborted;
                if (!again) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
            }
        }
    }

    /** Calls an action once. It is never sent again, whatever happens to the answer. */
    async act<O>(
        bound: BoundOperation,
        input: { json: unknown } | { form: FormData },
        options?: ActionOptions,
    ): Promise<ActionResult<O>> {
        // What is sent is fixed now, before anything waits: a later change to the object is not sent.
        let body: string | FormData;
        if ('form' in input) {
            if (!(input.form instanceof FormData)) {
                throw new RequestFailure('input', '.form() takes a FormData.', 'not-sent');
            }
            body = new FormData();
            for (const [name, value] of input.form.entries()) {
                body.append(name, value);
            }
        } else {
            if (bound.operation.mode === 'form') {
                throw new RequestFailure(
                    'input',
                    `$${bound.method} carries a file: call it with .form(formData).`,
                    'not-sent',
                );
            }
            try {
                body = encodeJson(input.json);
            } catch (error) {
                throw new RequestFailure('input', (error as Error).message, 'not-sent');
            }
        }
        if (!this.writable()) {
            // Refused here and never held: nothing is sent later on its own, as nobody then knows who by.
            throw new RequestFailure(
                'auth',
                'Who is signed in is changing. Try again once it has.',
                'not-sent',
            );
        }
        const epoch = this.epoch;
        const transition = bound.operation.auth;
        const mine = transition ? {} : null;
        if (mine !== null) {
            this.transition = mine;
        }
        const done = (): void => {
            if (mine !== null && this.transition === mine) {
                this.transition = null;
            }
        };
        try {
            const answer = await exchange({
                transport: this.transport,
                build: this.build,
                maxBytes: this.limits.maxResponseBytes,
                method: 'POST',
                url: buildPath(bound.mount.path, bound.scope.params),
                schema: bound.mount.schema,
                expects: 'action',
                body,
                headers:
                    transition && this.auth !== null
                        ? { 'X-PSX-Auth-Revision': this.auth.revision }
                        : undefined,
                signal: options?.signal,
            });
            if (answer.kind === 'redirect') {
                throw new RequestFailure('protocol', 'The answer cannot be read.', 'unknown');
            }
            if (answer.kind === 'problem') {
                if (!answer.expected) {
                    // It came after the method was entered and is not a failure the method returned:
                    // an exception, or something that answered in its place. Whatever its status,
                    // nothing is known of what was written, and nothing is sent again.
                    throw new RequestFailure(
                        'server',
                        answer.problem.message,
                        'unknown',
                        answer.problem.status,
                        answer.problem.requestId,
                    );
                }
                if (transition) {
                    // A refusal of an action that changes who is signed in is this page's to trust
                    // only when the server says, with it, who is signed in, and that is who the page
                    // knows. A guard that refused, a credential that is no longer good, a revision
                    // that moved: none says so, whatever its status or code, and the page is settled
                    // again before anything private is shown or written. The refusal is still given;
                    // nothing is sent again.
                    const seen = readAuth(answer.auth);
                    if (seen === null || this.auth === null || this.standing(seen) !== 'current') {
                        this.raise(seen);
                        void this.authChanged(false);
                        done();
                    }
                }
                return Object.freeze({ ok: false as const, problem: answer.problem });
            }
            const envelope = answer.envelope;
            this.conforms(bound.operation.shape as Shape, envelope.data, true);
            const redirect = envelope.redirect === undefined ? undefined : readRedirect(envelope.redirect);
            if (redirect === null) {
                throw new RequestFailure('protocol', 'The answer cannot be read.', 'unknown');
            }
            let auth: AuthTransitionState | undefined;
            if (envelope.authChanged === true || transition) {
                // The barrier is entered before this turn ends: no write fits between the two.
                this.raise(readAuth(envelope.auth));
                const reconciled = this.authChanged();
                done();
                auth = await reconciled;
            } else if (epoch === this.epoch) {
                // It is done whatever follows. What it says of who is signed in is held to what the
                // page knows, as any answer is; when that is in doubt the page is settled again.
                const standing = this.witness(envelope.auth);
                if (standing === 'doubtful') {
                    auth = await (this.router.reconciliation() ?? this.authChanged(false));
                } else if (Array.isArray(envelope.invalidate)) {
                    // The save is done whatever the refresh does: it is started, never awaited.
                    this.invalidate(envelope.invalidate.filter(tag => typeof tag === 'string'));
                }
            }
            return Object.freeze({
                ok: true as const,
                data: envelope.data as O,
                ...(redirect === undefined ? {} : { redirect }),
                ...(auth === undefined ? {} : { auth }),
            });
        } catch (error) {
            if (transition && error instanceof RequestFailure && error.outcome === 'unknown') {
                // The cookie may have changed whatever the answer was: find out before showing anything.
                void this.authChanged();
                done();
            }
            throw error;
        } finally {
            done();
            // Whatever came of it, it was sent: nothing read ahead of it is kept.
            this.router.forget();
        }
    }

    /** Marks what depends on these tags stale, and starts their refresh. */
    invalidate(tags: readonly string[]): void {
        if (tags.length === 0 || this.server) {
            return;
        }
        void this.queries.invalidate({ tags }).catch(() => undefined);
        this.router.invalidated(tags);
    }

    /**
     * Who is signed in changed: everything held for whoever it was is dropped, and the page is
     * loaded again with the browser's cookies as they are now. Until that is done nothing private
     * is shown.
     */
    async authChanged(broadcast = true): Promise<AuthTransitionState> {
        if (this.server || this.disposed) {
            return { status: 'document-required', origin: null };
        }
        this.epoch++;
        this.queries.clear();
        if (broadcast) {
            try {
                this.channel?.postMessage('changed');
            } catch {
                // A closed channel tells nobody; this tab still reconciles.
            }
        }
        return this.router.reconcile();
    }

    /** Whether a write may be sent now: not while who is signed in is changing or is not settled. */
    writable(): boolean {
        return this.transition === null && !this.router.barred();
    }

    /** How a snapshot an answer carried stands to who this page knows is signed in. */
    standing(seen: AuthSnapshot | null): Standing {
        const known = this.auth;
        if (known === null) {
            // Nothing was known: the application tells nobody apart, or this is the first it says.
            return seen === null ? 'current' : 'advanced';
        }
        if (seen === null || seen.context !== known.context) {
            // Saying nothing proves nothing; and revisions of two browser contexts have no order.
            return 'doubtful';
        }
        let position: number;
        try {
            position = order(seen.revision, known.revision);
        } catch {
            return 'doubtful';
        }
        if (seen.partition !== known.partition) {
            return 'doubtful';
        }
        return position === 0 ? 'current' : position > 0 ? 'advanced' : 'stale';
    }

    /**
     * Holds what an answer says of who is signed in to what the page knows, for an answer about to
     * be used. A later revision of the same person is taken; an earlier one is the caller's to
     * drop; and when it leaves who is signed in in doubt, everything held is dropped and the page
     * is loaded again as whoever the browser is now.
     */
    witness(carried: unknown): Standing {
        const seen = readAuth(carried);
        const standing = this.standing(seen);
        if (standing === 'advanced') {
            this.auth = seen;
        } else if (standing === 'doubtful') {
            this.doubt(seen);
        }
        return standing;
    }

    /** Who is signed in is an open question: settle it, with nothing of before on screen. */
    doubt(seen: AuthSnapshot | null): void {
        this.raise(seen);
        void this.authChanged(false);
    }

    /** Remembers the latest revision this browser context is known to have reached: nothing older is taken after it. */
    private raise(seen: AuthSnapshot | null): void {
        const known = this.auth;
        if (seen === null || known === null || seen.context !== known.context) {
            return;
        }
        try {
            if (order(seen.revision, known.revision) > 0) {
                this.auth = seen;
            }
        } catch {
            // A revision that is no number orders nothing.
        }
    }

    private conforms(shape: Shape, data: unknown, mutation: boolean): void {
        const found = mismatch(shape, data, 'data', 0, this.limits.maxDepth);
        if (found !== null) {
            const failure = new RequestFailure(
                'protocol',
                `The answer is not what its type says: ${found}.`,
                mutation ? 'unknown' : 'rejected',
            );
            this.onError?.(failure, { kind: 'protocol', build: this.build });
            throw failure;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.channel?.close();
        this.router.dispose();
        this.queries.clear();
        if (active === this) {
            active = null;
        }
    }
}

/** The address of a path's pattern with its parameters in place. */
export function buildPath(
    segments: readonly Segment[],
    params: Readonly<Record<string, string | number>>,
): string {
    let path = '';
    for (const segment of segments) {
        if ('text' in segment) {
            path += segment.text;
            continue;
        }
        const value = params[segment.name];
        if (
            (typeof value !== 'string' && typeof value !== 'number') ||
            String(value) === '' ||
            (typeof value === 'number' && !Number.isFinite(value))
        ) {
            throw new TypeError(`The path needs the parameter "${segment.name}".`);
        }
        const text = String(value);
        if (segment.expression === null) {
            path += encodeURIComponent(text);
            continue;
        }
        let allowed: RegExp | null = null;
        try {
            allowed = new RegExp(`^(?:${segment.expression})$`);
        } catch {
            // An expression only PHP reads is the server's to check.
        }
        if (allowed !== null && !allowed.test(text)) {
            throw new TypeError(`The path cannot take "${text}" as its parameter "${segment.name}".`);
        }
        // A parameter with an expression of its own may span segments.
        path += text.split('/').map(encodeURIComponent).join('/');
    }
    return path;
}

function isPlain(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function check(value: unknown, path: string, depth: number): void {
    if (depth > 64) {
        throw new TypeError(`${path} is nested too deep to send.`);
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError(`${path} is ${value}, which JSON cannot carry.`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => check(item, `${path}[${index}]`, depth + 1));
        return;
    }
    if (isPlain(value)) {
        for (const key of Object.keys(value)) {
            if (value[key] !== undefined) {
                check(value[key], `${path}.${key}`, depth + 1);
            }
        }
        return;
    }
    const what =
        value === undefined ? 'undefined' : (Object.getPrototypeOf(value)?.constructor?.name ?? typeof value);
    throw new TypeError(
        `${path} is ${what === 'undefined' ? 'undefined' : `a ${what}`}, which JSON cannot carry. Send a string, a number, a boolean, null, a list or a plain object${what === 'File' ? '; a file goes by .form(formData)' : ''}.`,
    );
}

/** An action's body as JSON. A property that is undefined is left out, as an absent field. */
export function encodeJson(input: unknown): string {
    if (!isPlain(input)) {
        throw new TypeError('An action takes an object of its fields.');
    }
    check(input, 'input', 0);
    return JSON.stringify(input);
}

/** A query's input as a query string, in the names the server reads strictly: a, a[b], a[], a[0][b]. */
export function encodeQuery(input: unknown): string {
    if (input === undefined || input === null) {
        return '';
    }
    if (!isPlain(input)) {
        throw new TypeError('A query takes an object of its fields.');
    }
    check(input, 'input', 0);
    const pairs: string[] = [];
    const add = (name: string, value: unknown): void => {
        if (value === null || value === undefined) {
            return;
        }
        if (Array.isArray(value)) {
            const flat = value.every(item => item === null || typeof item !== 'object');
            value.forEach((item, index) => add(flat ? `${name}[]` : `${name}[${index}]`, item));
        } else if (typeof value === 'object') {
            for (const key of Object.keys(value as object)) {
                add(`${name}[${key}]`, (value as Record<string, unknown>)[key]);
            }
        } else {
            pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
        }
    };
    for (const key of Object.keys(input)) {
        add(key, input[key]);
    }
    return pairs.join('&');
}

/** An input as text that is the same for the same input, whatever order its properties were written in. */
export function canonical(input: unknown): string {
    const order = (value: unknown): unknown => {
        if (Array.isArray(value)) {
            return value.map(order);
        }
        if (isPlain(value)) {
            const sorted: Record<string, unknown> = {};
            for (const key of Object.keys(value).sort()) {
                if (value[key] !== undefined) {
                    sorted[key] = order(value[key]);
                }
            }
            return sorted;
        }
        return value;
    };
    return JSON.stringify(order(input ?? {})) ?? '{}';
}
