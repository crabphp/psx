import { createElement, type ReactElement } from 'react';
import { MEDIA } from './protocol.js';
import { Runtime, setActiveRuntime } from './runtime.js';
import { mismatch } from './shapes.js';
import { facade, type PsxApp } from './start.js';
import type {
    AuthSnapshot,
    Limits,
    Manifest,
    PageEnvelope,
    PublicProblem,
    RedirectTarget,
    Segment,
    Shape,
    WireHead,
} from './types.js';
import { App } from './view.js';

const control = Symbol('control');

interface Control {
    [control]: 'problem' | 'redirect';
    problem?: PublicProblem;
    target?: RedirectTarget;
    execution?: 'entered' | 'not-entered';
    expected?: boolean;
    loaded?: unknown[];
}

/** A fixture that could not be what the server sends. It reaches the test as it is. */
export class FixtureError extends Error {
    override name = 'PsxFixtureError';
}

export interface ProblemOptions {
    fields?: Record<string, string[]>;
    /** Whether the operation had begun; a refusal by a guard had not. */
    execution?: 'entered' | 'not-entered';
    /**
     * False for what a method did not return: an exception thrown inside it, or a middleware's
     * answer in its place. An action so answered is a RequestFailure whose outcome is unknown.
     */
    expected?: boolean;
    /** For a page: the data of the loaders that ran before the one that failed, outermost first. */
    loaded?: unknown[];
}

/** A refusal or an expected failure for a fixture to answer with. */
export function problem(
    status: number,
    code: string,
    message: string,
    options: ProblemOptions = {},
): Control {
    return {
        [control]: 'problem',
        execution: options.execution ?? 'entered',
        expected: options.expected ?? true,
        loaded: options.loaded,
        problem: { status, code, message, fields: options.fields ?? {}, query: {}, path: {} },
    };
}

/** A redirect for a fixture to answer with. */
export function redirect(href: string, mode: 'internal' | 'document' = 'internal', replace = false): Control {
    return { [control]: 'redirect', target: { href, mode, replace } };
}

function isControl(value: unknown): value is Control {
    return typeof value === 'object' && value !== null && control in value;
}

export interface PageFixture {
    /** Each loader's data, the outermost layout first and the page last. */
    data: unknown[];
    head?: Partial<WireHead>;
    tags?: string[];
    auth?: AuthSnapshot;
}

export interface ActionFixture {
    data: unknown;
    invalidate?: string[];
    redirect?: RedirectTarget;
    authChanged?: boolean;
}

export interface RecordedRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
}

type Awaitable<T> = T | Promise<T>;

function expression(path: readonly Segment[]): RegExp {
    return new RegExp(
        `^${path
            .map(segment =>
                'text' in segment
                    ? segment.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    : `(?<${segment.name}>${segment.expression ?? '[^/]+'})`,
            )
            .join('')}$`,
    );
}

/**
 * Stands where the server would for a test. What a fixture answers is written as the server
 * writes it and held to the same shapes: a fixture cannot give a component what a real loader,
 * query or action could never send.
 */
export class FixtureTransport {
    readonly requests: RecordedRequest[] = [];
    private pages = new Map<
        string,
        (url: URL, params: Record<string, string>) => Awaitable<PageFixture | Control>
    >();
    private operations = new Map<
        string,
        (input: any, params: Record<string, string>) => Awaitable<unknown>
    >();
    private failing: Error | Response | null = null;

    constructor(
        private readonly manifest: Manifest,
        readonly build: string,
    ) {}

    /** What a page's loaders give when it is navigated to or loaded again. */
    page(
        route: string,
        handler: (url: URL, params: Record<string, string>) => Awaitable<PageFixture | Control>,
    ): this {
        if (this.manifest.routes[route] === undefined) {
            throw new Error(`The build has no page named "${route}".`);
        }
        this.pages.set(route, handler);
        return this;
    }

    /** What a query gives. Its input is the query string, read as the server reads it. */
    query(
        module: string,
        method: string,
        handler: (
            input: URLSearchParams,
            params: Record<string, string>,
        ) => Awaitable<unknown | { data: unknown; tags: string[] } | Control>,
    ): this {
        this.declared(module, method, 'query');
        this.operations.set(`${module} ${method}`, handler);
        return this;
    }

    /** What an action gives. Its input is the JSON body, or the FormData of a form. */
    action(
        module: string,
        method: string,
        handler: (input: any, params: Record<string, string>) => Awaitable<ActionFixture | Control>,
    ): this {
        this.declared(module, method, 'action');
        this.operations.set(`${module} ${method}`, handler);
        return this;
    }

    /** The next request never gets an answer, or gets this one, such as a proxy's own error page. */
    failNext(answer: Error | Response = new TypeError('Failed to fetch')): this {
        this.failing = answer;
        return this;
    }

    handle = async (url: string, init: RequestInit): Promise<Response> => {
        const target = new URL(url, 'http://localhost');
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((value, name) => {
            headers[name] = value;
        });
        let body: unknown = init.body ?? null;
        if (typeof body === 'string') {
            body = JSON.parse(body);
        }
        this.requests.push({ method: init.method ?? 'GET', url, headers, body });
        if (this.failing !== null) {
            const failing = this.failing;
            this.failing = null;
            if (failing instanceof Response) {
                return failing;
            }
            throw failing;
        }
        if (init.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }
        if (headers['x-psx-build'] !== this.build) {
            return this.control(409, {
                kind: 'problem',
                execution: 'not-entered',
                problem: {
                    status: 409,
                    code: 'build_mismatch',
                    message: 'The application was updated. Reload the page.',
                    fields: {},
                    query: {},
                    path: {},
                },
            });
        }
        for (const [module, methods] of Object.entries(this.manifest.operations)) {
            for (const [method, operation] of Object.entries(methods)) {
                for (const mount of Object.values(operation.mounts)) {
                    const match = expression(mount.path).exec(decodeURI(target.pathname));
                    if (match === null) {
                        continue;
                    }
                    const handler = this.operations.get(`${module} ${method}`);
                    if (handler === undefined) {
                        throw new FixtureError(
                            `The test calls $${method} of ${module} and gave no fixture for it.`,
                        );
                    }
                    const params = { ...(match.groups ?? {}) };
                    const answered = await handler(
                        operation.role === 'query' ? target.searchParams : body,
                        params,
                    );
                    if (isControl(answered)) {
                        return this.answer(answered);
                    }
                    if (operation.role === 'query') {
                        const wrapped =
                            typeof answered === 'object' &&
                            answered !== null &&
                            'data' in answered &&
                            'tags' in answered
                                ? (answered as { data: unknown; tags: string[] })
                                : { data: answered, tags: [] };
                        this.held(operation.shape as Shape, wrapped.data, `$${method}`);
                        return this.data(
                            { kind: 'query', data: wrapped.data, tags: wrapped.tags },
                            mount.schema,
                        );
                    }
                    const result = answered as ActionFixture;
                    this.held(operation.shape as Shape, result.data, `$${method}`);
                    return this.data(
                        {
                            kind: 'action',
                            ok: true,
                            data: result.data,
                            invalidate: result.invalidate ?? [],
                            authChanged: result.authChanged ?? false,
                            ...(result.redirect === undefined ? {} : { redirect: result.redirect }),
                        },
                        mount.schema,
                    );
                }
            }
        }
        for (const [name, route] of Object.entries(this.manifest.routes)) {
            const match = expression(route.path).exec(decodeURI(target.pathname));
            const handler = this.pages.get(name);
            if (match === null || handler === undefined) {
                continue;
            }
            const params = { ...(match.groups ?? {}) };
            const answered = await handler(target, params);
            if (isControl(answered)) {
                if (answered[control] === 'problem' && answered.loaded !== undefined) {
                    // As the server does: the problem, with what the loaders before it gave.
                    const loaded = answered.loaded;
                    const whole = pageEnvelope(
                        {
                            ...this.manifest,
                            routes: {
                                ...this.manifest.routes,
                                [name]: { ...route, nodes: route.nodes.slice(0, loaded.length) },
                            },
                        },
                        this.build,
                        name,
                        target.pathname + target.search,
                        params,
                        { data: loaded },
                    );
                    const { protocol: _protocol, kind: _kind, ...pageError } = whole;
                    return this.control(answered.problem!.status, {
                        kind: 'problem',
                        execution: answered.execution,
                        expected: answered.expected,
                        problem: answered.problem,
                        pageError,
                    });
                }
                return this.answer(answered);
            }
            return this.data(
                pageEnvelope(
                    this.manifest,
                    this.build,
                    name,
                    target.pathname + target.search,
                    params,
                    answered,
                ) as unknown as Record<string, unknown>,
                this.manifest.navigation,
            );
        }
        return this.control(404, {
            kind: 'problem',
            execution: 'not-entered',
            problem: {
                status: 404,
                code: 'not_found',
                message: 'Not Found',
                fields: {},
                query: {},
                path: {},
            },
        });
    };

    private declared(module: string, method: string, role: string): void {
        if (this.manifest.operations[module]?.[method]?.role !== role) {
            throw new Error(`${module} has no ${role} named ${method}().`);
        }
    }

    private held(shape: Shape, data: unknown, what: string): void {
        const found = mismatch(shape, data);
        if (found !== null) {
            throw new FixtureError(
                `The fixture for ${what} answers what the server could not send: ${found}.`,
            );
        }
    }

    private answer(answered: Control): Response {
        if (answered[control] === 'redirect') {
            return this.control(200, { kind: 'redirect', execution: 'entered', target: answered.target });
        }
        return this.control(answered.problem!.status, {
            kind: 'problem',
            execution: answered.execution,
            expected: answered.expected,
            problem: answered.problem,
        });
    }

    private control(status: number, envelope: Record<string, unknown>): Response {
        return new Response(
            JSON.stringify({
                protocol: 1,
                respondingBuild: this.build,
                requestedBuild: this.build,
                ...envelope,
            }),
            {
                status,
                headers: { 'Content-Type': MEDIA, 'X-PSX-Protocol': '1', 'X-PSX-Build': this.build },
            },
        );
    }

    private data(envelope: Record<string, unknown>, schema: string): Response {
        return new Response(JSON.stringify({ protocol: 1, build: this.build, ...envelope }), {
            status: 200,
            headers: {
                'Content-Type': MEDIA,
                'X-PSX-Protocol': '1',
                'X-PSX-Build': this.build,
                'X-PSX-Schema': schema,
            },
        });
    }
}

/** The envelope the server would write for a page, held to the shapes its loaders declare. */
export function pageEnvelope(
    manifest: Manifest,
    build: string,
    name: string,
    href: string,
    params: Record<string, string>,
    fixture: PageFixture,
): PageEnvelope {
    const route = manifest.routes[name];
    if (route === undefined) {
        throw new Error(`The build has no page named "${name}".`);
    }
    if (fixture.data.length !== route.nodes.length) {
        throw new FixtureError(
            `The page ${name} has ${route.nodes.length} loaders, and the fixture gives data for ${fixture.data.length}.`,
        );
    }
    const path = href.split('?')[0]!;
    return {
        protocol: 1,
        build,
        kind: 'page',
        route: { id: name, href },
        nodes: route.nodes.map((node, index) => {
            const found = mismatch(node.shape as Shape, fixture.data[index], `the data of ${node.mount}`);
            if (found !== null) {
                throw new FixtureError(
                    `The fixture for the page ${name} gives what the server could not send: ${found}.`,
                );
            }
            return {
                mount: node.mount,
                module: node.module,
                key: `${node.layout ?? name}:${node.layout === null ? Object.values(params).join('/') : ''}`,
                data: fixture.data[index],
                scope: { routeId: name, mountId: node.mount, href: path, params },
            };
        }),
        head: {
            title: fixture.head?.title ?? null,
            meta: fixture.head?.meta ?? {},
            links: fixture.head?.links ?? {},
        },
        tags: fixture.tags ?? [],
        ...(fixture.auth === undefined ? {} : { auth: fixture.auth }),
    };
}

export interface TestAppOptions {
    manifest: Manifest;
    /** The page the test starts on. */
    page: { route: string; href: string; params?: Record<string, string> } & PageFixture;
    build?: string;
    limits?: Partial<Limits>;
    onError?: (error: Error) => void;
}

export interface TestApp extends PsxApp {
    readonly transport: FixtureTransport;
    /** The application, to render with a React test renderer once `ready` has resolved. */
    readonly element: ReactElement;
    readonly ready: Promise<void>;
    /** The addresses the application left the document for, which a test's document cannot go to. */
    readonly left: string[];
    /** Of each of them, in order, whether it took the place of the entry shown. */
    readonly replaced: boolean[];
}

/**
 * An application of its own for a test, with fixtures where the server would be. It needs a
 * document with a location, as jsdom gives; nothing reaches a network.
 */
export function createTestApp(options: TestAppOptions): TestApp {
    const build = options.build ?? 'test-build';
    const transport = new FixtureTransport(options.manifest, build);
    const left: string[] = [];
    const replaced: boolean[] = [];
    const runtime = new Runtime({
        manifest: options.manifest,
        build,
        transport: transport.handle,
        leave: (href, replace) => {
            left.push(href);
            replaced.push(replace);
        },
        limits: options.limits,
        onError: options.onError,
    });
    setActiveRuntime(runtime);
    history.replaceState(null, '', options.page.href);
    const ready = runtime.router
        .install(
            pageEnvelope(
                options.manifest,
                build,
                options.page.route,
                options.page.href,
                options.page.params ?? {},
                options.page,
            ),
            options.page.href,
        )
        .then(() => undefined);
    return {
        transport,
        ready,
        left,
        replaced,
        element: createElement(App, { runtime }),
        router: facade(runtime),
        queries: runtime.queries,
        authChanged: () => runtime.authChanged(),
        dispose: () => runtime.dispose(),
    };
}
