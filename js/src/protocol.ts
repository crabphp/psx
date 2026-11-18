import { plain } from './shapes.js';
import type { PublicProblem, RedirectTarget } from './types.js';

export const MEDIA = 'application/vnd.crab.psx+json';
export const VERSION = 1;

/**
 * A request that did not get an answer the page can act on: the network, a proxy's own page, a
 * server error, another release. `outcome` says what is known of it: "not-sent" when nothing left
 * the browser, "rejected" when the server said it did nothing, and "unknown" otherwise. An action
 * whose outcome is unknown may have been done: look before sending it again.
 */
export class RequestFailure extends Error {
    readonly kind: 'network' | 'protocol' | 'server' | 'build' | 'aborted' | 'auth' | 'input';
    readonly status?: number;
    readonly requestId?: string;
    readonly outcome: 'not-sent' | 'rejected' | 'unknown';

    constructor(
        kind: RequestFailure['kind'],
        message: string,
        outcome: RequestFailure['outcome'],
        status?: number,
        requestId?: string,
    ) {
        super(message);
        this.name = 'RequestFailure';
        this.kind = kind;
        this.outcome = outcome;
        this.status = status;
        this.requestId = requestId;
    }
}

/** A query the server refused: not signed in, not allowed, not valid. It is expected, not a bug. */
export class QueryProblem extends Error {
    readonly problem: PublicProblem;

    constructor(problem: PublicProblem) {
        super(problem.message);
        this.name = 'QueryProblem';
        this.problem = problem;
    }
}

/** A query the server answered with somewhere to go. Nothing navigates by itself. */
export class QueryRedirect extends Error {
    readonly target: RedirectTarget;

    constructor(target: RedirectTarget) {
        super(`Redirected to ${target.href}`);
        this.name = 'QueryRedirect';
        this.target = target;
    }
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface Exchange {
    transport: Transport;
    build: string;
    maxBytes: number;
    method: 'GET' | 'POST';
    url: string;
    schema: string;
    /** The kind of data this request is answered with. */
    expects: 'page' | 'query' | 'action';
    body?: string | FormData;
    headers?: Record<string, string>;
    signal?: AbortSignal;
}

export type Answer =
    | { kind: 'data'; envelope: Record<string, unknown> }
    | {
          kind: 'problem';
          problem: PublicProblem;
          execution: 'entered' | 'not-entered';
          /**
           * Whether the server wrote this on purpose: a refusal before the method, or a failure the
           * method returned, which says nothing it did was kept. A problem that only followed the
           * method's entry, an exception or a middleware's answer, promises nothing of what was done.
           */
          expected: boolean;
          pageError?: unknown;
          /** Who the server says is signed in, as it wrote it, when the answer is this release's. */
          auth?: unknown;
      }
    | { kind: 'redirect'; target: RedirectTarget };

/**
 * Sends one request of the protocol and reads its answer: first the small part any release can
 * read, a problem or a redirect, and only then data, which must be this release's and of the
 * schema asked for. A redirect of HTTP's own is never followed, and nothing is ever sent twice.
 */
export async function exchange(request: Exchange): Promise<Answer> {
    const mutation = request.method === 'POST';
    // Once it has left, an action may have been done whatever came back.
    const sent = mutation ? 'unknown' : 'rejected';
    let response: Response;
    try {
        response = await request.transport(request.url, {
            method: request.method,
            credentials: 'same-origin',
            redirect: 'error',
            cache: 'no-store',
            signal: request.signal,
            body: request.body,
            headers: {
                Accept: MEDIA,
                'X-PSX-Protocol': String(VERSION),
                'X-PSX-Build': request.build,
                'X-PSX-Schema': request.schema,
                ...(typeof request.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
                ...request.headers,
            },
        });
    } catch (error) {
        if (error instanceof Error && error.name === 'PsxFixtureError') {
            // A test's fixture is wrong: that is the test's to hear, not a network failure.
            throw error;
        }
        if (request.signal?.aborted) {
            throw new RequestFailure('aborted', 'The request was cancelled.', sent);
        }
        throw new RequestFailure(
            'network',
            mutation
                ? 'The server could not be reached, or answered with a redirect.'
                : 'The server could not be reached.',
            sent,
        );
    }
    const requestId = response.headers.get('X-Request-Id') ?? undefined;
    const type = (response.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== MEDIA) {
        // A proxy's page, a login page, an error of something in between: not an answer.
        throw new RequestFailure(
            response.status >= 500 ? 'server' : 'protocol',
            `The server answered ${response.status} with something that is not the application's.`,
            sent,
            response.status,
            requestId,
        );
    }
    const declared = Number(response.headers.get('Content-Length') ?? '0');
    let text: string;
    try {
        text = declared > request.maxBytes ? '' : await response.text();
    } catch {
        throw new RequestFailure('network', 'The answer was cut short.', sent, response.status, requestId);
    }
    if (declared > request.maxBytes || text.length > request.maxBytes) {
        throw new RequestFailure(
            'protocol',
            'The answer is larger than this page accepts.',
            sent,
            response.status,
            requestId,
        );
    }
    let envelope: unknown;
    try {
        envelope = JSON.parse(text);
    } catch {
        envelope = null;
    }
    if (!plain(envelope) || envelope.protocol !== VERSION || typeof envelope.kind !== 'string') {
        throw new RequestFailure('protocol', 'The answer cannot be read.', sent, response.status, requestId);
    }
    if (envelope.kind === 'problem') {
        const problem = readProblem(envelope.problem, response);
        const execution = envelope.execution === 'not-entered' ? 'not-entered' : 'entered';
        if (problem === null || problem.status !== response.status) {
            throw new RequestFailure(
                'protocol',
                'The answer cannot be read.',
                sent,
                response.status,
                requestId,
            );
        }
        const outcome = execution === 'not-entered' ? 'rejected' : sent;
        if (problem.code === 'build_mismatch') {
            throw new RequestFailure('build', problem.message, outcome, problem.status, problem.requestId);
        }
        if (problem.code === 'unsupported_protocol' || problem.code === 'protocol') {
            throw new RequestFailure('protocol', problem.message, outcome, problem.status, problem.requestId);
        }
        if (problem.status >= 500) {
            throw new RequestFailure('server', problem.message, outcome, problem.status, problem.requestId);
        }
        // Said by the server and by nothing else: never taken from the status or the code.
        const expected = execution === 'not-entered' || envelope.expected === true;
        if (!expected) {
            // It came after the method was entered and is not a failure the method returned: an
            // exception, or something that answered in its place. Whatever its status it is not a
            // refusal the caller was promised, of a read no more than of a write.
            throw new RequestFailure('server', problem.message, sent, problem.status, problem.requestId);
        }
        return {
            kind: 'problem',
            problem,
            execution,
            expected,
            auth: envelope.respondingBuild === request.build ? envelope.auth : undefined,
            // What the loaders before the failed one gave, when it is this release's.
            pageError:
                plain(envelope.pageError) && envelope.pageError.build === request.build
                    ? envelope.pageError
                    : undefined,
        };
    }
    if (envelope.kind === 'redirect') {
        const target = readRedirect(envelope.target);
        if (target === null || response.status !== 200) {
            throw new RequestFailure(
                'protocol',
                'The answer cannot be read.',
                sent,
                response.status,
                requestId,
            );
        }
        return { kind: 'redirect', target };
    }
    if (
        response.status !== 200 ||
        envelope.kind !== request.expects ||
        envelope.build !== request.build ||
        response.headers.get('X-PSX-Build') !== request.build ||
        response.headers.get('X-PSX-Schema') !== request.schema
    ) {
        throw new RequestFailure(
            envelope.build !== request.build ? 'build' : 'protocol',
            'The answer is not of this page’s release.',
            sent,
            response.status,
            requestId,
        );
    }
    return { kind: 'data', envelope };
}

function messages(value: unknown): Readonly<Record<string, readonly string[]>> | null {
    if (!plain(value)) {
        return null;
    }
    const fields: Record<string, readonly string[]> = Object.create(null);
    let count = 0;
    for (const key of Object.keys(value)) {
        const list = value[key];
        if (++count > 1000 || !Array.isArray(list) || list.some(item => typeof item !== 'string')) {
            return null;
        }
        fields[key] = Object.freeze(list.map(item => String(item).slice(0, 2000)));
    }
    return Object.freeze(fields);
}

export function readProblem(value: unknown, response?: Response): PublicProblem | null {
    if (!plain(value)) {
        return null;
    }
    const fields = messages(value.fields);
    const query = messages(value.query);
    const path = messages(value.path);
    if (
        typeof value.status !== 'number' ||
        !Number.isInteger(value.status) ||
        value.status < 400 ||
        value.status > 599 ||
        typeof value.code !== 'string' ||
        typeof value.message !== 'string' ||
        fields === null ||
        query === null ||
        path === null
    ) {
        return null;
    }
    const retry = Number(response?.headers.get('Retry-After') ?? value.retryAfter ?? NaN);
    const login = typeof value.loginUrl === 'string' ? safeHref(value.loginUrl) : null;
    return Object.freeze({
        status: value.status,
        code: value.code.slice(0, 64),
        message: value.message.slice(0, 2000),
        fields,
        query,
        path,
        ...(typeof value.requestId === 'string' ? { requestId: value.requestId.slice(0, 128) } : {}),
        ...(Number.isFinite(retry) && retry >= 0 ? { retryAfter: retry } : {}),
        ...(login !== null ? { loginUrl: login } : {}),
    });
}

export function readRedirect(value: unknown): RedirectTarget | null {
    if (
        !plain(value) ||
        typeof value.href !== 'string' ||
        (value.mode !== 'internal' && value.mode !== 'document')
    ) {
        return null;
    }
    const href = safeHref(value.href);
    if (href === null || (value.mode === 'internal' && !href.startsWith('/'))) {
        return null;
    }
    return Object.freeze({ href, mode: value.mode, replace: value.replace === true });
}

/** An address a page may be sent to: a path of this site, or an http(s) one. Never a script. */
export function safeHref(href: string): string | null {
    if (href.length > 4096 || /[\u0000-\u001f\\]/.test(href)) {
        return null;
    }
    if (href.startsWith('/')) {
        return href.startsWith('//') ? null : href;
    }
    return /^https?:\/\/[^\s/?#]+/i.test(href) ? href : null;
}
