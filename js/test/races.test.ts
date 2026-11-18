import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryProblem, RequestFailure } from '../src/protocol.js';
import { Runtime } from '../src/runtime.js';
import { start } from '../src/start.js';
import { useRouter } from '../src/view.js';
import { renderPage } from '../src/ssr.js';
import type { AuthSnapshot, Manifest, NavigationOrigin, PageEnvelope, RouteScope } from '../src/types.js';

/**
 * Regressions for the first review round of the client, R1-C01 to R1-C07. Every order of events
 * is set by the test: an answer is a promise the test resolves when it chooses, never a timer
 * that happens to win.
 */

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
}

function deferred<T = Response>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

/** Lets everything that is ready run: microtasks, and the timers of this turn. */
const turn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const paths: Record<string, string> = { one: '/one', two: '/two', three: '/three' };
const string = { k: 'string' } as const;

const manifest: Manifest = {
    protocol: 1,
    navigation: 'nav',
    wrapper: null,
    modules: { p: async () => ({ default: () => null }) },
    routes: Object.fromEntries(
        Object.entries(paths).map(([id, path]) => [
            id,
            {
                path: [{ text: path }],
                schema: `s-${id}`,
                query: [],
                nodes: [{ mount: `${id}/page`, module: 'p', layout: null, shape: string }],
            },
        ]),
    ),
    services: {},
    operations: {
        p: {
            save: {
                role: 'action',
                mode: 'both',
                auth: false,
                shape: string,
                mounts: { 'one/page': { id: 'a', schema: 'sa', path: [{ text: '/one/_psx/a/a' }] } },
            },
            login: {
                role: 'action',
                mode: 'both',
                auth: true,
                shape: string,
                mounts: { 'one/page': { id: 'l', schema: 'sl', path: [{ text: '/one/_psx/a/l' }] } },
            },
            q: {
                role: 'query',
                mode: 'both',
                auth: false,
                shape: string,
                mounts: { 'one/page': { id: 'q', schema: 'sq', path: [{ text: '/one/_psx/q/q' }] } },
            },
        },
    },
};

function answer(body: Record<string, unknown>, schema: string, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/vnd.crab.psx+json',
            'X-PSX-Protocol': '1',
            'X-PSX-Build': 'b',
            'X-PSX-Schema': schema,
        },
    });
}

const globalAnswer = answer;

function pageEnvelope(id: string, data: string = id, auth?: AuthSnapshot): Record<string, unknown> {
    return {
        protocol: 1,
        build: 'b',
        kind: 'page',
        route: { id, href: paths[id] },
        nodes: [
            {
                mount: `${id}/page`,
                module: 'p',
                key: id,
                data,
                scope: { routeId: id, mountId: `${id}/page`, href: paths[id], params: {} },
            },
        ],
        head: { title: data, meta: {}, links: {} },
        tags: ['items'],
        ...(auth === undefined ? {} : { auth }),
    };
}

const page = (id: string, data?: string, auth?: AuthSnapshot): Response =>
    answer(pageEnvelope(id, data, auth), 'nav');

const queried = (data: string, auth?: AuthSnapshot): Response =>
    answer(
        { protocol: 1, build: 'b', kind: 'query', data, tags: ['items'], ...(auth ? { auth } : {}) },
        'sq',
    );

const acted = (schema: string, extra: Record<string, unknown> = {}): Response =>
    answer(
        {
            protocol: 1,
            build: 'b',
            kind: 'action',
            ok: true,
            data: 'saved',
            invalidate: [],
            authChanged: false,
            ...extra,
        },
        schema,
    );

const redirected = (href: string, mode: 'internal' | 'document' = 'internal'): Response =>
    answer(
        {
            protocol: 1,
            kind: 'redirect',
            respondingBuild: 'b',
            requestedBuild: 'b',
            execution: 'entered',
            target: { href, mode, replace: false },
        },
        'nav',
    );

/** A request that is answered only by its cancellation, and that a turn after it was cancelled. */
function hanging(init: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
            'abort',
            () => setTimeout(() => reject(new DOMException('cancelled', 'AbortError')), 0),
            { once: true },
        );
    });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

interface Harness {
    runtime: Runtime;
    left: string[];
    /** Of each address left for, whether it took the place of the entry shown. */
    replaced: boolean[];
    requests: { method: string; url: string }[];
    /** Replaces what answers. */
    serve(handler: Handler): void;
    snapshot(): ReturnType<Runtime['router']['getSnapshot']>;
    origin(): NavigationOrigin;
    scope(): RouteScope;
    data(): unknown;
}

const byAddress: Handler = url => page(Object.keys(paths).find(id => paths[id] === url) ?? 'one');
let open: Harness | null = null;

async function app(options: { auth?: AuthSnapshot; limits?: Record<string, number> } = {}): Promise<Harness> {
    history.replaceState(null, '', '/one');
    const left: string[] = [];
    const replaced: boolean[] = [];
    const requests: { method: string; url: string }[] = [];
    let handler: Handler = byAddress;
    const runtime = new Runtime({
        manifest,
        build: 'b',
        limits: options.limits,
        transport: async (url, init) => {
            requests.push({ method: init.method ?? 'GET', url });
            return handler(url, init);
        },
        leave: (href, replace) => {
            left.push(href);
            replaced.push(replace);
        },
    });
    await runtime.router.install(pageEnvelope('one', 'initial', options.auth), '/one');
    const snapshot = (): ReturnType<Runtime['router']['getSnapshot']> => runtime.router.getSnapshot();
    open = {
        runtime,
        left,
        replaced,
        requests,
        serve: next => {
            handler = next;
        },
        snapshot,
        origin: () => snapshot().page!.origin,
        scope: () => snapshot().page!.nodes[0]!.scope,
        data: () => snapshot().page?.nodes[0]?.data,
    };
    return open;
}

afterEach(() => {
    open?.runtime.dispose();
    open = null;
});

const posts = (test: Harness): number => test.requests.filter(request => request.method === 'POST').length;

describe('R1-C01: a navigation that leaves the document obeys ifCurrent and blockers', () => {
    it.each([
        ['an ordinary address of this site', '/ordinary-login', 'http://localhost:3000/ordinary-login'],
        ['another site', 'https://elsewhere.example/in', 'https://elsewhere.example/in'],
    ])('does not leave for %s from a page that is no longer the one shown', async (_what, target) => {
        const test = await app();
        const old = test.origin();
        await test.runtime.router.navigate('/two');
        expect(await test.runtime.router.navigate(target, { ifCurrent: old })).toEqual({
            status: 'superseded',
        });
        expect(test.left).toEqual([]);
        expect(test.snapshot().location.href).toBe('/two');
    });

    it.each([
        ['an ordinary address of this site', '/ordinary-login', '/ordinary-login'],
        ['another site', 'https://elsewhere.example/in', 'https://elsewhere.example/in'],
    ])(
        'asks a blocker before leaving for %s, and leaves only when it says so',
        async (_what, target, shown) => {
            const test = await app();
            const blocker = test.runtime.router.block(() => true);
            const absolute = new URL(target, location.href).href;
            expect(await test.runtime.router.navigate(target, { ifCurrent: test.origin() })).toEqual({
                status: 'blocked',
            });
            expect(test.left).toEqual([]);
            expect(blocker.getSnapshot()).toEqual({ href: shown, type: 'push' });

            blocker.reset();
            expect(test.left).toEqual([]);

            expect(await test.runtime.router.navigate(target)).toEqual({ status: 'blocked' });
            expect(await blocker.proceed()).toEqual({ status: 'document', href: absolute });
            expect(test.left).toEqual([absolute]);
            blocker.dispose();
        },
    );

    it('still leaves at once when nothing holds it back, from the page that is shown', async () => {
        const test = await app();
        expect(await test.runtime.router.navigate('/ordinary-login', { ifCurrent: test.origin() })).toEqual({
            status: 'document',
            href: `${location.origin}/ordinary-login`,
        });
        expect(test.left).toEqual([`${location.origin}/ordinary-login`]);
    });

    it('lets a newer navigation take the place of one a blocker held', async () => {
        const test = await app();
        let hold = true;
        const blocker = test.runtime.router.block(() => hold);
        await test.runtime.router.navigate('/ordinary-login');
        hold = false;
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
        // What was held is nobody's to let through now.
        expect(blocker.getSnapshot()).toBeNull();
        expect(await blocker.proceed()).toEqual({ status: 'superseded' });
        expect(test.left).toEqual([]);
    });

    it('follows a loader’s redirect to the document only once nothing holds it back', async () => {
        const test = await app();
        test.serve(() => redirected('/two', 'document'));
        const blocker = test.runtime.router.block(() => true);
        await test.runtime.router.revalidate();
        expect(test.left).toEqual([]);
        expect(blocker.getSnapshot()).toEqual({ href: '/two', type: 'replace' });
        expect(await blocker.proceed()).toEqual({ status: 'document', href: `${location.origin}/two` });
        expect(test.left).toEqual([`${location.origin}/two`]);
    });
});

describe('R1-C02: an origin is of the navigation that made it', () => {
    it('leaves the old page’s origin behind when the address is replaced in its entry', async () => {
        const test = await app();
        const old = test.origin();
        expect(await test.runtime.router.navigate('/two', { replace: true })).toEqual({
            status: 'committed',
            href: '/two',
        });
        expect(test.snapshot().location.entryKey).toBe(old.entryKey);
        expect(await test.runtime.router.navigate('/three', { ifCurrent: old })).toEqual({
            status: 'superseded',
        });
        expect(test.snapshot().location.href).toBe('/two');
        expect(test.data()).toBe('two');
    });

    it('lets the page that is shown redirect itself: its own navigation does not cancel it', async () => {
        const test = await app();
        await test.runtime.router.navigate('/two', { replace: true });
        expect(await test.runtime.router.navigate('/three', { ifCurrent: test.origin() })).toEqual({
            status: 'committed',
            href: '/three',
        });
        expect(test.data()).toBe('three');
    });

    it('keeps the origin through a refresh of the same page', async () => {
        const test = await app();
        const origin = test.origin();
        await test.runtime.router.revalidate();
        expect(test.data()).toBe('one');
        expect(test.origin()).toBe(origin);
        expect(test.runtime.router.current(origin)).toBe(true);
    });

    it('leaves old callbacks stale while an attempt is held, and gives the page a fresh origin when it is reset', async () => {
        const test = await app();
        const old = test.origin();
        const scope = test.scope();
        const blocker = test.runtime.router.block(() => true);
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'blocked' });
        expect(test.runtime.router.current(old)).toBe(false);
        expect(await test.runtime.router.navigate('/three', { ifCurrent: old })).toEqual({
            status: 'superseded',
        });
        // The refused attempt above was no intent: what is held is still held.
        expect(blocker.getSnapshot()).toEqual({ href: '/two', type: 'push' });

        blocker.reset();
        blocker.dispose();
        const fresh = test.scope();
        expect(fresh).not.toBe(scope);
        expect(Object.isFrozen(fresh)).toBe(true);
        expect(Object.isFrozen(fresh.navigation)).toBe(true);
        // The fresh scope is one this runtime made: it binds.
        expect(test.runtime.bind('p', 'save', fresh).scope).toBe(fresh);
        expect(test.runtime.router.current(old)).toBe(false);
        expect(test.runtime.router.current(fresh.navigation!)).toBe(true);
        expect(test.snapshot().page!.commit).toBe(1);
        expect(await test.runtime.router.navigate('/three', { ifCurrent: old })).toEqual({
            status: 'superseded',
        });
        expect(await test.runtime.router.navigate('/three', { ifCurrent: fresh.navigation! })).toEqual({
            status: 'committed',
            href: '/three',
        });
    });

    it('does the same when an attempt fails', async () => {
        const test = await app();
        const old = test.origin();
        test.serve(() => Promise.reject(new TypeError('Failed to fetch')));
        const failed = await test.runtime.router.navigate('/two');
        expect(failed.status).toBe('failed');
        test.serve(byAddress);
        expect(test.runtime.router.current(old)).toBe(false);
        expect(test.runtime.router.current(test.origin())).toBe(true);
        expect(await test.runtime.router.navigate('/three', { ifCurrent: old })).toEqual({
            status: 'superseded',
        });
        expect(await test.runtime.router.navigate('/three', { ifCurrent: test.origin() })).toEqual({
            status: 'committed',
            href: '/three',
        });
    });

    it('leaves behind the origin an entry had when it is returned to by Back', async () => {
        const test = await app();
        const first = test.origin();
        await test.runtime.router.navigate('/two');
        const second = test.origin();
        history.back();
        await vi.waitFor(() => expect(test.snapshot().location.href).toBe('/one'));
        expect(test.snapshot().location.entryKey).toBe(first.entryKey);
        expect(test.runtime.router.current(first)).toBe(false);
        expect(test.runtime.router.current(second)).toBe(false);
        expect(test.runtime.router.current(test.origin())).toBe(true);

        history.forward();
        await vi.waitFor(() => expect(test.snapshot().location.href).toBe('/two'));
        expect(test.runtime.router.current(second)).toBe(false);
        expect(test.runtime.router.current(test.origin())).toBe(true);
    });

    it('gives the page a fresh origin when it moves to another place in itself', async () => {
        const test = await app();
        const old = test.origin();
        expect(await test.runtime.router.navigate('/one#below')).toEqual({
            status: 'committed',
            href: '/one#below',
        });
        expect(test.runtime.router.current(old)).toBe(false);
        expect(test.runtime.router.current(test.origin())).toBe(true);
        expect(test.snapshot().page!.commit).toBe(1);
    });
});

describe('R1-C05: of two refreshes of a page, the one asked for later is kept', () => {
    it('whatever order their answers come in', async () => {
        const test = await app();
        const first = deferred();
        const second = deferred();
        let asked = 0;
        test.serve(() => (++asked === 1 ? first.promise : second.promise));
        const a = test.runtime.router.revalidate();
        const b = test.runtime.router.revalidate();
        second.resolve(page('one', 'newer'));
        await b;
        expect(test.data()).toBe('newer');
        first.resolve(page('one', 'older'));
        await a;
        expect(test.data()).toBe('newer');
        expect(document.title).toBe('newer');
    });

    it('and takes each in turn when they come in the order they were asked', async () => {
        const test = await app();
        const first = deferred();
        const second = deferred();
        let asked = 0;
        test.serve(() => (++asked === 1 ? first.promise : second.promise));
        const a = test.runtime.router.revalidate();
        const b = test.runtime.router.revalidate();
        first.resolve(page('one', 'older'));
        await a;
        expect(test.data()).toBe('older');
        second.resolve(page('one', 'newer'));
        await b;
        expect(test.data()).toBe('newer');
    });

    it('lets neither the failure nor the redirect of an overtaken refresh through', async () => {
        const test = await app();
        const first = deferred();
        const second = deferred();
        const third = deferred();
        let asked = 0;
        test.serve(() => [first, second, third][asked++]!.promise);
        const a = test.runtime.router.revalidate();
        const b = test.runtime.router.revalidate();
        const c = test.runtime.router.revalidate();
        third.resolve(page('one', 'newest'));
        await c;
        first.reject(new TypeError('Failed to fetch'));
        await a;
        second.resolve(redirected('/two'));
        await b;
        expect(test.data()).toBe('newest');
        expect(test.snapshot().navigationError).toBeNull();
        expect(test.snapshot().location.href).toBe('/one');
    });

    it('keeps the failure of the latest refresh when an earlier one then succeeds', async () => {
        const test = await app();
        const first = deferred();
        const second = deferred();
        let asked = 0;
        test.serve(() => (++asked === 1 ? first.promise : second.promise));
        const a = test.runtime.router.revalidate();
        const b = test.runtime.router.revalidate();
        second.reject(new TypeError('Failed to fetch'));
        await b;
        expect(test.snapshot().navigationError?.failure.kind).toBe('network');
        first.resolve(page('one', 'earlier, and newer than what was shown'));
        await a;
        // Newer than what was on screen, so it is shown; and the page may still be out of date.
        expect(test.data()).toBe('earlier, and newer than what was shown');
        expect(test.snapshot().navigationError?.failure.kind).toBe('network');
    });

    it('orders the refreshes two saves start, when the second answers first', async () => {
        const test = await app();
        const first = deferred();
        const second = deferred();
        let asked = 0;
        test.serve(() => (++asked === 1 ? first.promise : second.promise));
        test.runtime.invalidate(['items']);
        test.runtime.invalidate(['items']);
        second.resolve(page('one', 'after the second save'));
        await vi.waitFor(() => expect(test.data()).toBe('after the second save'));
        first.resolve(page('one', 'after the first save'));
        await turn();
        await turn();
        expect(test.data()).toBe('after the second save');
    });

    it('is not undone by an attempt to leave that was held and given up', async () => {
        const test = await app();
        const refresh = deferred();
        test.serve(() => refresh.promise);
        const refreshing = test.runtime.router.revalidate();
        const blocker = test.runtime.router.block(() => true);
        await test.runtime.router.navigate('/two');
        blocker.reset();
        blocker.dispose();
        refresh.resolve(page('one', 'refreshed'));
        await refreshing;
        expect(test.data()).toBe('refreshed');
        expect(test.runtime.router.current(test.origin())).toBe(true);
    });

    it('is dropped once another page is shown', async () => {
        const test = await app();
        const refresh = deferred();
        test.serve(url => (url === '/one' ? refresh.promise : byAddress(url, {})));
        const refreshing = test.runtime.router.revalidate();
        await test.runtime.router.navigate('/two');
        refresh.resolve(page('one', 'late'));
        await refreshing;
        expect(test.snapshot().location.href).toBe('/two');
        expect(test.data()).toBe('two');
        expect(test.snapshot().page!.href).toBe('/two');
    });
});

describe('R1-C03: while who is signed in is not settled, nothing is written and nothing old is shown', () => {
    it('takes the title and the head tags of whoever was signed in out of the document too', async () => {
        const test = await app();
        const read = deferred();
        test.serve(() => read.promise);
        document.title = 'Inbox of who was signed in';
        const own = document.createElement('meta');
        own.setAttribute('data-psx-head', 'description');
        own.setAttribute('content', 'theirs');
        document.head.appendChild(own);
        const kept = document.createElement('meta');
        kept.setAttribute('name', 'viewport');
        document.head.appendChild(kept);

        const changing = test.runtime.authChanged();
        expect(document.title).toBe('');
        expect(document.head.querySelector('[data-psx-head]')).toBeNull();
        // What the document had of its own stays.
        expect(document.head.querySelector('meta[name="viewport"]')).toBe(kept);

        read.resolve(page('one', 'as who is signed in now'));
        await changing;
        expect(document.title).toBe('as who is signed in now');
        kept.remove();
    });

    it('refuses a write as not sent, and sends it once the page is settled', async () => {
        const test = await app();
        const read = deferred();
        test.serve((_url, init) => (init.method === 'POST' ? acted('sa') : read.promise));
        const save = test.runtime.bind('p', 'save', test.scope());
        const changing = test.runtime.authChanged();
        expect(test.snapshot().reconciling).toBe(true);
        // Nothing of whoever was signed in stays in the page's state.
        expect(test.snapshot().page).toBeNull();

        const refused = await test.runtime.act(save, { json: {} }).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(RequestFailure);
        expect(refused).toMatchObject({ kind: 'auth', outcome: 'not-sent' });
        expect(posts(test)).toBe(0);

        read.resolve(page('one', 'as who is signed in now'));
        expect(await changing).toMatchObject({ status: 'reconciled' });
        expect(test.runtime.writable()).toBe(true);
        // The refused write was not kept to be sent later.
        expect(posts(test)).toBe(0);
        expect(await test.runtime.act(save, { json: {} })).toMatchObject({ ok: true });
        expect(posts(test)).toBe(1);
    });

    it.each([
        [
            'is refused',
            () =>
                answer(
                    {
                        protocol: 1,
                        kind: 'problem',
                        respondingBuild: 'b',
                        requestedBuild: 'b',
                        execution: 'not-entered',
                        problem: {
                            status: 401,
                            code: 'unauthenticated',
                            message: 'Sign in.',
                            fields: {},
                            query: {},
                            path: {},
                        },
                    },
                    'nav',
                    401,
                ),
        ],
        ['is sent to sign in', () => redirected('/login', 'document')],
        ['cannot be reached', () => Promise.reject(new TypeError('Failed to fetch'))],
    ])(
        'keeps refusing writes when the page %s and only the document can say who it is',
        async (_what, reply) => {
            const test = await app();
            test.serve((_url, init) => (init.method === 'POST' ? acted('sa') : reply()));
            const save = test.runtime.bind('p', 'save', test.scope());
            expect(await test.runtime.authChanged()).toEqual({ status: 'document-required', origin: null });
            expect(test.snapshot()).toMatchObject({ reconciling: true, documentRequired: true, page: null });
            await expect(test.runtime.act(save, { json: {} })).rejects.toMatchObject({
                kind: 'auth',
                outcome: 'not-sent',
            });
            expect(posts(test)).toBe(0);
            // And nothing moved the document by itself.
            expect(test.left).toEqual([]);
        },
    );

    it('gives up after its time when the page never answers, and stays closed', async () => {
        const test = await app({ limits: { authReconcileSeconds: 0.02 } });
        // A transport that does not even hear its cancellation.
        test.serve(() => new Promise<Response>(() => undefined));
        expect(await test.runtime.authChanged()).toEqual({ status: 'document-required', origin: null });
        expect(test.runtime.writable()).toBe(false);
        expect(test.snapshot().documentRequired).toBe(true);
    });

    it('holds a navigation until the page is settled, and never shows one page under another’s address', async () => {
        const test = await app();
        const read = deferred();
        test.serve(url => (url === '/one' ? read.promise : byAddress(url, {})));
        const changing = test.runtime.authChanged();
        const going = test.runtime.router.navigate('/two');
        await turn();
        // Held: nothing was asked for, and the address has not moved.
        expect(test.requests.map(request => request.url)).toEqual(['/one']);
        expect(test.snapshot().location.href).toBe('/one');
        expect(location.pathname).toBe('/one');

        read.resolve(page('one', 'settled'));
        expect(await changing).toMatchObject({ status: 'reconciled' });
        expect(await going).toEqual({ status: 'committed', href: '/two' });
        expect(test.snapshot().location.href).toBe('/two');
        expect(test.snapshot().page!.href).toBe('/two');
        expect(test.data()).toBe('two');
        expect(test.snapshot().reconciling).toBe(false);
    });

    it('sends a held navigation to the document when the page cannot be settled here', async () => {
        const test = await app();
        const read = deferred();
        test.serve(() => read.promise);
        const changing = test.runtime.authChanged();
        const going = test.runtime.router.navigate('/two');
        read.reject(new TypeError('Failed to fetch'));
        await changing;
        expect(await going).toEqual({ status: 'document', href: `${location.origin}/two` });
        expect(test.left).toEqual([`${location.origin}/two`]);
        expect(test.snapshot().page).toBeNull();
        expect(test.runtime.writable()).toBe(false);
    });

    it('does not move for an old page’s callback while it settles', async () => {
        const test = await app();
        const old = test.origin();
        const read = deferred();
        test.serve(() => read.promise);
        const changing = test.runtime.authChanged();
        expect(await test.runtime.router.navigate('/two', { ifCurrent: old })).toEqual({
            status: 'superseded',
        });
        read.resolve(page('one', 'settled'));
        await changing;
        // Nor after: the page is another sign-in's now.
        expect(await test.runtime.router.navigate('/two', { ifCurrent: old })).toEqual({
            status: 'superseded',
        });
        expect(test.snapshot().location.href).toBe('/one');
    });

    it('lets only the latest of two changes settle the page, and tells both callers how it went', async () => {
        const test = await app();
        const first = deferred();
        const second = deferred();
        let asked = 0;
        test.serve(() => (++asked === 1 ? first.promise : second.promise));
        const a = test.runtime.authChanged();
        const b = test.runtime.authChanged();

        // The first change's read answers, late and as who was signed in between the two.
        first.resolve(page('one', 'as the one in between'));
        await turn();
        expect(test.snapshot().reconciling).toBe(true);
        expect(test.snapshot().page).toBeNull();
        expect(test.runtime.writable()).toBe(false);

        second.resolve(page('one', 'as the last'));
        const [first_, second_] = await Promise.all([a, b]);
        expect(second_).toMatchObject({ status: 'reconciled' });
        expect(first_).toEqual(second_);
        expect(test.data()).toBe('as the last');
        expect(test.runtime.writable()).toBe(true);
    });

    it('does not let the failure of an overtaken settling close what the latest one opened', async () => {
        const test = await app();
        const first = deferred();
        const second = deferred();
        let asked = 0;
        test.serve(() => (++asked === 1 ? first.promise : second.promise));
        const a = test.runtime.authChanged();
        const b = test.runtime.authChanged();
        second.resolve(page('one', 'as the last'));
        await b;
        first.reject(new TypeError('Failed to fetch'));
        expect(await a).toMatchObject({ status: 'reconciled' });
        expect(test.snapshot()).toMatchObject({ reconciling: false, documentRequired: false });
        expect(test.data()).toBe('as the last');
    });

    it('lets one action that changes who is signed in through, refuses others meanwhile, and keeps its success when the page cannot be settled', async () => {
        const test = await app();
        const signing = deferred();
        test.serve((url, init) =>
            init.method === 'POST'
                ? url.endsWith('/l')
                    ? signing.promise
                    : acted('sa')
                : Promise.reject(new TypeError('Failed to fetch')),
        );
        const login = test.runtime.bind('p', 'login', test.scope());
        const save = test.runtime.bind('p', 'save', test.scope());
        const result = test.runtime.act(login, { json: {} });
        await turn();
        // In flight: another write, and another sign-in, are refused before they are sent.
        await expect(test.runtime.act(save, { json: {} })).rejects.toMatchObject({ outcome: 'not-sent' });
        await expect(test.runtime.act(login, { json: {} })).rejects.toMatchObject({ outcome: 'not-sent' });
        expect(posts(test)).toBe(1);

        signing.resolve(acted('sl', { authChanged: true }));
        // The sign-in happened; that the page could not be loaded again does not make it a failure.
        expect(await result).toEqual({
            ok: true,
            data: 'saved',
            auth: { status: 'document-required', origin: null },
        });
        await expect(test.runtime.act(save, { json: {} })).rejects.toMatchObject({ outcome: 'not-sent' });
        expect(posts(test)).toBe(1);
    });

    it('leaves no gap for a write between the answer of a sign-in and the settling it starts', async () => {
        const test = await app();
        const read = deferred();
        const seen: boolean[] = [];
        test.serve((_url, init) => {
            if (init.method === 'POST') {
                return acted('sl', { authChanged: true });
            }
            // The first thing asked for after the sign-in answered: writes are closed by now.
            seen.push(test.runtime.writable());
            return read.promise;
        });
        const result = test.runtime.act(test.runtime.bind('p', 'login', test.scope()), { json: {} });
        await vi.waitFor(() => expect(seen).toEqual([false]));
        expect(test.runtime.writable()).toBe(false);
        read.resolve(page('one', 'signed in'));
        expect(await result).toMatchObject({ ok: true, auth: { status: 'reconciled' } });
        expect(test.runtime.writable()).toBe(true);
    });

    it('does not let a sign-in that has ended open the writes a later sign-in closed (R2-C03)', async () => {
        const test = await app();
        const second = deferred();
        let logins = 0;
        test.serve((url, init) => {
            if (init.method !== 'POST') {
                return page('one', 'settled');
            }
            if (url.endsWith('/l')) {
                return ++logins === 1 ? acted('sl', { authChanged: true }) : second.promise;
            }
            return acted('sa');
        });
        const scope = test.scope();
        const login = (): Promise<unknown> =>
            test.runtime.act(test.runtime.bind('p', 'login', scope), { json: {} });
        const save = (): Promise<unknown> =>
            test.runtime.act(test.runtime.bind('p', 'save', scope), { json: {} });
        // A subscriber that starts the next sign-in in the very turn the barrier opens.
        let following: Promise<unknown> | null = null;
        const off = test.runtime.router.subscribe(() => {
            if (following === null && !test.snapshot().reconciling && logins === 1) {
                following = login();
            }
        });
        expect(await login()).toMatchObject({ ok: true, auth: { status: 'reconciled' } });
        off();
        expect(following).not.toBeNull();
        expect(logins).toBe(2);
        // The first sign-in has ended, cleanup and all; the second is still in flight.
        await turn();
        expect(test.runtime.writable()).toBe(false);
        await expect(save()).rejects.toMatchObject({ kind: 'auth', outcome: 'not-sent' });
        await expect(login()).rejects.toMatchObject({ kind: 'auth', outcome: 'not-sent' });
        expect(posts(test)).toBe(2);

        second.resolve(acted('sl', { authChanged: true }));
        expect(await following).toMatchObject({ ok: true, auth: { status: 'reconciled' } });
        expect(test.runtime.writable()).toBe(true);
        expect(await save()).toMatchObject({ ok: true });
    });

    it('lets go of its own hold when a sign-in is refused as who the page knows, and of no more than that', async () => {
        const who: AuthSnapshot = { context: 'ctx', revision: '5', partition: 'user' };
        const test = await app({ auth: who });
        test.serve((url, init) =>
            init.method === 'POST' && url.endsWith('/l')
                ? answer(
                      {
                          protocol: 1,
                          kind: 'problem',
                          respondingBuild: 'b',
                          requestedBuild: 'b',
                          execution: 'entered',
                          expected: true,
                          problem: {
                              status: 422,
                              code: 'validation',
                              message: 'Wrong password.',
                              fields: {},
                              query: {},
                              path: {},
                          },
                          // The server's word that who is signed in is still who the page knows.
                          auth: who,
                      },
                      'sl',
                      422,
                  )
                : acted('sa', { auth: who }),
        );
        const scope = test.scope();
        const refused = await test.runtime.act(test.runtime.bind('p', 'login', scope), { json: {} });
        expect(refused).toMatchObject({ ok: false, problem: { status: 422 } });
        expect(test.runtime.writable()).toBe(true);
        expect(await test.runtime.act(test.runtime.bind('p', 'save', scope), { json: {} })).toMatchObject({
            ok: true,
        });
    });

    it('settles the page when a sign-in’s answer is lost: it may have happened', async () => {
        const test = await app();
        const read = deferred();
        test.serve((_url, init) =>
            init.method === 'POST' ? Promise.reject(new TypeError('Failed to fetch')) : read.promise,
        );
        const login = test.runtime.bind('p', 'login', test.scope());
        await expect(test.runtime.act(login, { json: {} })).rejects.toMatchObject({ outcome: 'unknown' });
        expect(test.snapshot().reconciling).toBe(true);
        expect(test.runtime.writable()).toBe(false);
        // Nothing was sent a second time.
        expect(posts(test)).toBe(1);
        read.resolve(page('one', 'whoever it is now'));
        await test.runtime.router.reconciliation();
        expect(test.runtime.writable()).toBe(true);
        expect(test.data()).toBe('whoever it is now');
    });

    it('settles the page at the entry a step through history was already on its way to', async () => {
        const test = await app();
        await test.runtime.router.navigate('/two');
        const back = deferred();
        const settled = deferred();
        let asked = 0;
        test.serve(() => (++asked === 1 ? back.promise : settled.promise));
        history.back();
        await vi.waitFor(() => expect(test.snapshot().pending).toEqual({ href: '/one' }));
        expect(location.pathname).toBe('/one');

        const changing = test.runtime.authChanged();
        // The address bar is at /one already: that is the place the page is settled at.
        expect(test.snapshot().location.href).toBe('/one');
        back.resolve(page('one', 'asked for as who was signed in before'));
        settled.resolve(page('one', 'as who is signed in now'));
        expect(await changing).toMatchObject({ status: 'reconciled' });
        expect(test.snapshot().location.href).toBe('/one');
        expect(test.snapshot().page!.href).toBe('/one');
        expect(test.data()).toBe('as who is signed in now');
    });

    it('leaves a step through history to the document while it settles', async () => {
        const test = await app();
        await test.runtime.router.navigate('/two');
        test.serve(() => new Promise<Response>(() => undefined));
        void test.runtime.authChanged();
        history.back();
        await vi.waitFor(() => expect(test.left).toEqual([`${location.origin}/one`]));
        expect(test.snapshot().page).toBeNull();
    });
});

describe('R1-C04: an answer is held to who the page knows is signed in', () => {
    const now: AuthSnapshot = { context: 'ctx', revision: '5', partition: 'new-user' };
    const before: AuthSnapshot = { context: 'ctx', revision: '4', partition: 'old-user' };

    it('never shows a page answered as whoever was signed in before, and settles who is', async () => {
        const test = await app({ auth: now });
        const settled = deferred();
        test.serve(url => (url === '/two' ? page('two', 'old private data', before) : settled.promise));
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'superseded' });
        expect(test.runtime.auth).toEqual(now);
        expect(test.snapshot().page).toBeNull();
        expect(test.snapshot().reconciling).toBe(true);
        expect(test.snapshot().location.href).toBe('/one');

        settled.resolve(page('one', 'the new user’s', now));
        expect(await test.runtime.router.reconciliation()).toMatchObject({ status: 'reconciled' });
        expect(test.data()).toBe('the new user’s');
        expect(test.runtime.auth).toEqual(now);
    });

    it('asks for the document when the browser itself still answers as before', async () => {
        const test = await app({ auth: now });
        test.serve(url => page(url === '/two' ? 'two' : 'one', 'old private data', before));
        await test.runtime.router.navigate('/two');
        expect(await test.runtime.router.reconciliation()).toEqual({
            status: 'document-required',
            origin: null,
        });
        expect(test.runtime.auth).toEqual(now);
        expect(test.snapshot().page).toBeNull();
        expect(test.runtime.writable()).toBe(false);
        // One read to settle it, and no more: it does not go round.
        expect(test.requests.map(request => request.url)).toEqual(['/two', '/one']);
    });

    it('drops an older answer about the same person, and says so without closing the page', async () => {
        const test = await app({ auth: now });
        test.serve(() => page('two', 'older', { ...now, revision: '4' }));
        const result = await test.runtime.router.navigate('/two');
        expect(result).toMatchObject({ status: 'failed' });
        expect(test.snapshot().navigationError?.failure).toMatchObject({ kind: 'auth', outcome: 'rejected' });
        expect(test.runtime.auth).toEqual(now);
        expect(test.data()).toBe('initial');
        expect(test.snapshot().reconciling).toBe(false);
        expect(test.requests).toHaveLength(1);
    });

    it('takes a later revision of the same person, and orders revisions as numbers', async () => {
        const test = await app({ auth: { ...now, revision: '9' } });
        test.serve(url => page(url === '/two' ? 'two' : 'three', undefined, { ...now, revision: '10' }));
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
        expect(test.runtime.auth?.revision).toBe('10');
        // "9" is after "10" as text, and before it as a number.
        test.serve(() => page('three', 'older', { ...now, revision: '9' }));
        expect(await test.runtime.router.navigate('/three')).toMatchObject({ status: 'failed' });
        expect(test.runtime.auth?.revision).toBe('10');
        expect(test.data()).toBe('two');
    });

    it.each([
        ['says nothing of who is signed in', undefined],
        ['is of another browser context', { context: 'other', revision: '1', partition: 'new-user' }],
        ['is of someone else at the same revision', { ...now, partition: 'someone-else' }],
        ['is of someone else at a later revision', { ...now, revision: '6', partition: 'someone-else' }],
        ['has a revision that is no number', { ...now, revision: '6a' }],
    ])('does not show a page that %s, and settles who is signed in', async (_what, carried) => {
        const test = await app({ auth: now });
        const settled = deferred();
        test.serve(url =>
            url === '/two' ? page('two', 'unproven', carried as AuthSnapshot | undefined) : settled.promise,
        );
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'superseded' });
        expect(test.snapshot()).toMatchObject({ reconciling: true, page: null });
        expect(test.snapshot().location.href).toBe('/one');
        settled.resolve(page('one', 'settled', { context: 'ctx', revision: '7', partition: 'whoever' }));
        expect(await test.runtime.router.reconciliation()).toMatchObject({ status: 'reconciled' });
        expect(test.runtime.auth).toEqual({ context: 'ctx', revision: '7', partition: 'whoever' });
        expect(test.data()).toBe('settled');
    });

    it('takes the fresh read as it is when the browser context itself is another', async () => {
        const test = await app({ auth: now });
        const other: AuthSnapshot = { context: 'other', revision: '1', partition: 'guest' };
        test.serve(() => page('one', 'as a guest', other));
        expect(await test.runtime.authChanged()).toMatchObject({ status: 'reconciled' });
        expect(test.runtime.auth).toEqual(other);
    });

    it('does not take a settling read that says nothing, when the application says who on every page', async () => {
        const test = await app({ auth: now });
        test.serve(() => page('one', 'says nothing'));
        expect(await test.runtime.authChanged()).toEqual({ status: 'document-required', origin: null });
        expect(test.snapshot().page).toBeNull();
        expect(test.runtime.auth).toEqual(now);
    });

    it('holds a refresh, a step through history and a page fetched ahead to the same', async () => {
        const test = await app({ auth: now });
        // A refresh answered as before: not shown.
        const settled = deferred();
        let asked = 0;
        test.serve(() => (++asked === 1 ? page('one', 'old private data', before) : settled.promise));
        await test.runtime.router.revalidate();
        expect(test.snapshot()).toMatchObject({ reconciling: true, page: null });
        settled.resolve(page('one', 'settled', now));
        await test.runtime.router.reconciliation();

        // A page fetched ahead, then a later revision learned: the fetched page is asked for again.
        test.serve(() => page('two', 'fetched ahead', now));
        await test.runtime.router.prefetch('/two');
        const later = { ...now, revision: '6' };
        test.serve(url => page(url === '/two' ? 'two' : 'one', 'fresh', later));
        await test.runtime.router.revalidate();
        expect(test.runtime.auth).toEqual(later);
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
        expect(test.data()).toBe('fresh');

        // Back to an entry, answered as before: not shown, and settled at that entry.
        const again = deferred();
        asked = 0;
        test.serve(() => (++asked === 1 ? page('one', 'old private data', before) : again.promise));
        history.back();
        await vi.waitFor(() => expect(test.snapshot().reconciling).toBe(true));
        expect(test.snapshot().page).toBeNull();
        expect(test.snapshot().location.href).toBe('/one');
        again.resolve(page('one', 'settled again', later));
        await test.runtime.router.reconciliation();
        expect(test.snapshot().page!.href).toBe('/one');
        expect(test.data()).toBe('settled again');
    });

    it('holds a query’s answer to it too, and gives none that was asked as someone else', async () => {
        const test = await app({ auth: now });
        const query = test.runtime.bind('p', 'q', test.scope());
        test.serve(() => queried('fine', now));
        expect(await test.runtime.read(query, {})).toMatchObject({ data: 'fine' });

        test.serve(() => queried('older', { ...now, revision: '4' }));
        await expect(test.runtime.read(query, {})).rejects.toMatchObject({
            kind: 'auth',
            outcome: 'rejected',
        });
        expect(test.snapshot().reconciling).toBe(false);

        // Asked, then who is signed in changes before it answers: it is nobody's.
        const slow = deferred();
        const settled = deferred();
        test.serve(url => (url.includes('/_psx/q/') ? slow.promise : settled.promise));
        const reading = test.runtime.read(query, {});
        const changing = test.runtime.authChanged();
        slow.resolve(queried('the old user’s', now));
        await expect(reading).rejects.toMatchObject({ kind: 'auth', outcome: 'rejected' });
        settled.resolve(page('one', 'settled', now));
        await changing;

        // Answered as someone else: dropped, and the page is settled.
        const fresh = test.runtime.bind('p', 'q', test.scope());
        const settling = deferred();
        test.serve(url =>
            url.includes('/_psx/q/') ? queried('old private data', before) : settling.promise,
        );
        await expect(test.runtime.read(fresh, {})).rejects.toMatchObject({ kind: 'auth' });
        expect(test.snapshot()).toMatchObject({ reconciling: true, page: null });
        settling.resolve(page('one', 'settled', now));
        await test.runtime.router.reconciliation();
    });

    it('gives a query’s answer of a later revision of the same person, to a direct call and to the cache', async () => {
        const test = await app({ auth: now });
        const later = { ...now, revision: '6' };
        const query = test.runtime.bind('p', 'q', test.scope());
        test.serve(() => queried('at six', later));
        expect(await test.runtime.read(query, {})).toMatchObject({ data: 'at six' });
        expect(test.runtime.auth).toEqual(later);
        expect(test.snapshot().reconciling).toBe(false);

        const latest = { ...now, revision: '10' };
        test.serve(() => queried('at ten', latest));
        const entry = test.runtime.queries.entry(query, {});
        const off = test.runtime.queries.subscribe(entry, () => undefined, {});
        await vi.waitFor(() =>
            expect(test.runtime.queries.snapshot(entry)).toMatchObject({
                status: 'success',
                data: 'at ten',
                error: null,
                isFetching: false,
            }),
        );
        expect(test.runtime.auth).toEqual(latest);
        expect(test.snapshot().reconciling).toBe(false);
        // And what is older than that is still dropped, with what was read kept.
        test.serve(() => queried('at six again', later));
        await expect(test.runtime.queries.snapshot<string>(entry).refetch()).rejects.toMatchObject({
            kind: 'auth',
            outcome: 'rejected',
        });
        expect(test.runtime.queries.snapshot(entry)).toMatchObject({ status: 'success', data: 'at ten' });
        expect(test.runtime.auth).toEqual(latest);
        off();
    });

    it('takes the first account of who is signed in from a query, to a direct call and to the cache', async () => {
        const test = await app();
        const query = test.runtime.bind('p', 'q', test.scope());
        test.serve(() => queried('first', now));
        const entry = test.runtime.queries.entry(query, {});
        const off = test.runtime.queries.subscribe(entry, () => undefined, {});
        await vi.waitFor(() =>
            expect(test.runtime.queries.snapshot(entry)).toMatchObject({ status: 'success', data: 'first' }),
        );
        expect(test.runtime.auth).toEqual(now);
        expect(await test.runtime.read(query, {})).toMatchObject({ data: 'first' });
        expect(test.snapshot().reconciling).toBe(false);
        off();
    });

    it('takes a later revision of the same person from a save’s answer, and refreshes what it says changed', async () => {
        const test = await app({ auth: now });
        const later = { ...now, revision: '6' };
        test.serve((_url, init) =>
            init.method === 'POST'
                ? acted('sa', { auth: later, invalidate: ['items'] })
                : page('one', 'refreshed', later),
        );
        const result = await test.runtime.act(test.runtime.bind('p', 'save', test.scope()), { json: {} });
        expect(result).toEqual({ ok: true, data: 'saved' });
        expect(test.runtime.auth).toEqual(later);
        await vi.waitFor(() => expect(test.data()).toBe('refreshed'));
        expect(test.snapshot().reconciling).toBe(false);
    });

    it('keeps a save that was done, and settles the page when its answer puts who is signed in in doubt', async () => {
        const test = await app({ auth: now });
        const settled = deferred();
        test.serve((_url, init) =>
            init.method === 'POST' ? acted('sa', { auth: before }) : settled.promise,
        );
        const saving = test.runtime.act(test.runtime.bind('p', 'save', test.scope()), { json: {} });
        await vi.waitFor(() => expect(test.snapshot().reconciling).toBe(true));
        settled.resolve(page('one', 'settled', now));
        expect(await saving).toMatchObject({ ok: true, data: 'saved', auth: { status: 'reconciled' } });
        expect(posts(test)).toBe(1);
    });

    it('takes the first account of who is signed in without closing anything', async () => {
        const test = await app();
        test.serve(() => page('two', 'two', now));
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
        expect(test.runtime.auth).toEqual(now);
        expect(test.snapshot().reconciling).toBe(false);
    });
});

describe('R1-C06: a query that lost its readers and found one again is read', () => {
    it('keeps the request when a reader leaves and returns in the same turn', async () => {
        const test = await app();
        const reply = deferred();
        const aborted: boolean[] = [];
        test.serve((_url, init) => {
            init.signal?.addEventListener('abort', () => aborted.push(true));
            return reply.promise;
        });
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), {});
        const off = test.runtime.queries.subscribe(entry, () => undefined, {});
        off();
        const again = test.runtime.queries.subscribe(entry, () => undefined, {});
        await turn();
        expect(test.requests).toHaveLength(1);
        expect(aborted).toEqual([]);
        expect(test.runtime.queries.snapshot(entry)).toMatchObject({ status: 'pending', isFetching: true });
        reply.resolve(queried('read'));
        await vi.waitFor(() =>
            expect(test.runtime.queries.snapshot(entry)).toMatchObject({
                status: 'success',
                data: 'read',
                isFetching: false,
            }),
        );
        again();
    });

    it('starts a request of its own when the old one is still being cancelled', async () => {
        const test = await app();
        const second = deferred();
        let asked = 0;
        test.serve((_url, init) => (++asked === 1 ? hanging(init) : second.promise));
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), {});
        const told: boolean[] = [];
        const off = test.runtime.queries.subscribe(entry, () => undefined, {});
        off();
        // The turn ends with nobody reading: the request is let go, and is no longer the entry's.
        await Promise.resolve();
        expect(test.runtime.queries.snapshot(entry)).toMatchObject({ status: 'pending', isFetching: false });

        // A reader returns before the transport has said the first request was cancelled.
        const again = test.runtime.queries.subscribe(
            entry,
            () => told.push(test.runtime.queries.snapshot(entry).isFetching),
            {},
        );
        expect(asked).toBe(2);
        expect(test.runtime.queries.snapshot(entry)).toMatchObject({ status: 'pending', isFetching: true });

        // Now the first request's cancellation settles: it changes nothing of the second.
        await turn();
        await turn();
        expect(test.runtime.queries.snapshot(entry)).toMatchObject({ status: 'pending', isFetching: true });
        expect(asked).toBe(2);

        second.resolve(queried('read'));
        await vi.waitFor(() =>
            expect(test.runtime.queries.snapshot(entry)).toMatchObject({
                status: 'success',
                data: 'read',
                error: null,
                isFetching: false,
            }),
        );
        expect(told.at(-1)).toBe(false);
        again();
    });

    it('does not let the answer of a request that was let go take the place of the new one’s', async () => {
        const test = await app();
        const first = deferred();
        const second = deferred();
        let asked = 0;
        // A transport that answers even what was cancelled.
        test.serve(() => (++asked === 1 ? first.promise : second.promise));
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), {});
        test.runtime.queries.subscribe(entry, () => undefined, {})();
        await Promise.resolve();
        const again = test.runtime.queries.subscribe(entry, () => undefined, {});
        first.resolve(queried('of the request that was let go'));
        await turn();
        expect(test.runtime.queries.snapshot(entry)).toMatchObject({ status: 'pending', isFetching: true });
        second.resolve(queried('of the new one'));
        await vi.waitFor(() =>
            expect(test.runtime.queries.snapshot(entry)).toMatchObject({ data: 'of the new one' }),
        );
        again();
    });

    it('keeps a request others still read when one of them leaves', async () => {
        const test = await app();
        const reply = deferred();
        const aborted: boolean[] = [];
        test.serve((_url, init) => {
            init.signal?.addEventListener('abort', () => aborted.push(true));
            return reply.promise;
        });
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), {});
        const one = test.runtime.queries.subscribe(entry, () => undefined, {});
        const two = test.runtime.queries.subscribe(entry, () => undefined, {});
        one();
        await turn();
        expect(aborted).toEqual([]);
        expect(test.requests).toHaveLength(1);
        reply.resolve(queried('shared'));
        await vi.waitFor(() => expect(test.runtime.queries.snapshot(entry).data).toBe('shared'));
        two();
    });

    it('lets a request go when its last reader leaves, and leaves nothing behind', async () => {
        const test = await app({ limits: { queryCacheGcSeconds: 0.01 } });
        const aborted: boolean[] = [];
        test.serve((_url, init) => {
            init.signal?.addEventListener('abort', () => aborted.push(true));
            return hanging(init);
        });
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), {});
        const before = test.runtime.queries.size;
        test.runtime.queries.subscribe(entry, () => undefined, {})();
        await turn();
        expect(aborted).toEqual([true]);
        expect(test.runtime.queries.snapshot(entry)).toMatchObject({ isFetching: false, error: null });
        await vi.waitFor(() => expect(test.runtime.queries.size).toBe(before - 1));
    });
});

describe('R1-C07: a reader that is disabled watches, and causes nothing to be read', () => {
    it('is not read for by an invalidation, and is read once a reader is enabled', async () => {
        const test = await app();
        test.serve(() => queried('read'));
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), {});
        const off = test.runtime.queries.subscribe(entry, () => undefined, { enabled: false });
        await test.runtime.queries.invalidate();
        await test.runtime.queries.invalidate({ key: entry.key });
        test.runtime.invalidate(['items']);
        await turn();
        expect(test.requests.filter(request => request.url.includes('/_psx/q/'))).toEqual([]);
        expect(test.runtime.queries.snapshot(entry)).toMatchObject({ status: 'pending', isFetching: false });

        // The same reader, enabled now, as when its input became complete.
        off();
        const on = test.runtime.queries.subscribe(entry, () => undefined, { enabled: true });
        await vi.waitFor(() => expect(test.runtime.queries.snapshot(entry).data).toBe('read'));
        expect(test.requests.filter(request => request.url.includes('/_psx/q/'))).toHaveLength(1);
        on();
    });

    it('marks what a disabled reader shows stale, so that enabling it reads again', async () => {
        const test = await app();
        let version = 0;
        test.serve(() => queried(`v${++version}`));
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), {});
        const first = test.runtime.queries.subscribe(entry, () => undefined, { staleTime: 60_000 });
        await vi.waitFor(() => expect(test.runtime.queries.snapshot(entry).data).toBe('v1'));
        first();
        const watching = test.runtime.queries.subscribe(entry, () => undefined, {
            enabled: false,
            staleTime: 60_000,
        });
        await test.runtime.queries.invalidate({ tags: ['items'] });
        expect(version).toBe(1);
        expect(test.runtime.queries.snapshot(entry).data).toBe('v1');
        watching();
        // Within its stale time, and still read again: the invalidation said it changed.
        const enabled = test.runtime.queries.subscribe(entry, () => undefined, { staleTime: 60_000 });
        await vi.waitFor(() => expect(test.runtime.queries.snapshot(entry).data).toBe('v2'));
        enabled();
    });

    it('reads once for an enabled reader beside a disabled one', async () => {
        const test = await app();
        let version = 0;
        test.serve(() => queried(`v${++version}`));
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), {});
        const watching = test.runtime.queries.subscribe(entry, () => undefined, { enabled: false });
        const reading = test.runtime.queries.subscribe(entry, () => undefined, {});
        await vi.waitFor(() => expect(test.runtime.queries.snapshot(entry).data).toBe('v1'));
        await test.runtime.queries.invalidate();
        expect(version).toBe(2);
        expect(test.runtime.queries.snapshot(entry).data).toBe('v2');

        // The enabled reader leaves: the next invalidation reads nothing.
        reading();
        await test.runtime.queries.invalidate();
        await turn();
        expect(version).toBe(2);
        watching();
    });

    it('lets go of a request when only a disabled reader is left', async () => {
        const test = await app();
        const aborted: boolean[] = [];
        test.serve((_url, init) => {
            init.signal?.addEventListener('abort', () => aborted.push(true));
            return hanging(init);
        });
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), {});
        const told: boolean[] = [];
        const watching = test.runtime.queries.subscribe(
            entry,
            () => told.push(test.runtime.queries.snapshot(entry).isFetching),
            { enabled: false },
        );
        const reading = test.runtime.queries.subscribe(entry, () => undefined, {});
        reading();
        await turn();
        expect(aborted).toEqual([true]);
        expect(told.at(-1)).toBe(false);
        watching();
    });

    it('reads for a disabled reader that asks by refetch(), and keeps that request to its end', async () => {
        const test = await app();
        const first = deferred();
        let asked = 0;
        test.serve(() => (++asked === 1 ? first.promise : queried('after the invalidation')));
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), {});
        const watching = test.runtime.queries.subscribe(entry, () => undefined, { enabled: false });
        const asking = test.runtime.queries.snapshot<string>(entry).refetch();
        expect(asked).toBe(1);
        // What it reads changes while it is asked: the answer it gets is of after the change.
        const invalidating = test.runtime.queries.invalidate();
        first.resolve(queried('of before the invalidation'));
        expect(await asking).toBe('after the invalidation');
        await invalidating;
        expect(asked).toBe(2);
        // And nothing more is read on its behalf.
        await test.runtime.queries.invalidate();
        await turn();
        expect(asked).toBe(2);
        watching();
    });
});

function refusal(
    status: number,
    code: string,
    options: {
        execution?: 'entered' | 'not-entered';
        expected?: boolean;
        schema?: string;
        pageError?: unknown;
        auth?: unknown;
        respondingBuild?: string;
    } = {},
): Response {
    return answer(
        {
            protocol: 1,
            kind: 'problem',
            respondingBuild: options.respondingBuild ?? 'b',
            requestedBuild: 'b',
            execution: options.execution ?? 'entered',
            ...(options.expected === undefined ? {} : { expected: options.expected }),
            problem: { status, code, message: `Answered ${status}.`, fields: {}, query: {}, path: {} },
            ...(options.pageError === undefined ? {} : { pageError: options.pageError }),
            ...(options.auth === undefined ? {} : { auth: options.auth }),
        },
        options.schema ?? 'sa',
        status,
    );
}

describe('R1-S01: what an action is told of a failure is what the server knows of it', () => {
    it.each([
        ['a 422 thrown after the write', 422, 'validation'],
        ['a 409 thrown after the write', 409, 'conflict'],
        ['a 404 a middleware answered with in its place', 404, 'not_found'],
        ['a 403', 403, 'forbidden'],
    ])(
        'takes %s for an unknown outcome, whatever its status, and sends nothing again',
        async (_what, status, code) => {
            const test = await app();
            test.serve(() => refusal(status, code, { execution: 'entered', expected: false }));
            const failure = await test.runtime
                .act(test.runtime.bind('p', 'save', test.scope()), { json: {} })
                .catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(RequestFailure);
            expect(failure).toMatchObject({ kind: 'server', outcome: 'unknown', status });
            expect(posts(test)).toBe(1);
        },
    );

    it('does the same when the server does not say the failure was expected', async () => {
        const test = await app();
        test.serve(() => refusal(422, 'validation', { execution: 'entered' }));
        await expect(
            test.runtime.act(test.runtime.bind('p', 'save', test.scope()), { json: {} }),
        ).rejects.toMatchObject({ outcome: 'unknown' });
    });

    it('gives a failure the method returned as a result: it says nothing was kept', async () => {
        const test = await app();
        test.serve(() => refusal(409, 'conflict', { execution: 'entered', expected: true }));
        expect(await test.runtime.act(test.runtime.bind('p', 'save', test.scope()), { json: {} })).toEqual({
            ok: false,
            problem: expect.objectContaining({ status: 409, code: 'conflict' }),
        });
    });

    it('gives a refusal before the method as a result too, whatever else the envelope says', async () => {
        const test = await app();
        test.serve(() => refusal(422, 'validation', { execution: 'not-entered', expected: false }));
        expect(
            await test.runtime.act(test.runtime.bind('p', 'save', test.scope()), { json: {} }),
        ).toMatchObject({
            ok: false,
            problem: { status: 422 },
        });
    });

    it('settles who is signed in after an unexpected failure of an action that changes it', async () => {
        const test = await app();
        const settled = deferred();
        test.serve((_url, init) =>
            init.method === 'POST'
                ? refusal(422, 'validation', { expected: false, schema: 'sl' })
                : settled.promise,
        );
        await expect(
            test.runtime.act(test.runtime.bind('p', 'login', test.scope()), { json: {} }),
        ).rejects.toMatchObject({ outcome: 'unknown' });
        expect(test.snapshot().reconciling).toBe(true);
        settled.resolve(page('one', 'whoever it is now'));
        await test.runtime.router.reconciliation();
        expect(test.runtime.writable()).toBe(true);
    });

    it('settles who is signed in when a sign-in is refused as stale: someone else changed it', async () => {
        const test = await app();
        const settled = deferred();
        test.serve((_url, init) =>
            init.method === 'POST'
                ? refusal(409, 'auth_transition', { execution: 'not-entered', schema: 'sl' })
                : settled.promise,
        );
        const result = await test.runtime.act(test.runtime.bind('p', 'login', test.scope()), { json: {} });
        expect(result).toMatchObject({ ok: false, problem: { code: 'auth_transition' } });
        expect(test.snapshot()).toMatchObject({ reconciling: true, page: null });
        expect(test.runtime.writable()).toBe(false);
        settled.resolve(page('one', 'as who is signed in now'));
        expect(await test.runtime.router.reconciliation()).toMatchObject({ status: 'reconciled' });
        expect(test.data()).toBe('as who is signed in now');
        expect(posts(test)).toBe(1);
    });
});

describe('R3-C02: a refusal of an action that changes who is signed in proves nothing of who is', () => {
    const now: AuthSnapshot = { context: 'ctx', revision: '5', partition: 'user' };
    const login = async (
        refused: Response,
        known: AuthSnapshot | undefined = now,
    ): Promise<{
        test: Awaited<ReturnType<typeof app>>;
        result: unknown;
        scope: RouteScope;
        settle: (data: string) => Promise<void>;
    }> => {
        const test = await app({ auth: known });
        const settled = deferred();
        test.serve((_url, init) => (init.method === 'POST' ? refused.clone() : settled.promise));
        const scope = test.scope();
        const result = await test.runtime.act(test.runtime.bind('p', 'login', scope), { json: {} });
        return {
            test,
            scope,
            result,
            settle: async data => {
                settled.resolve(page('one', data, known));
                await test.runtime.router.reconciliation();
            },
        };
    };

    it.each([
        ['a guard’s 401 before the action: the credential is no longer good', 401, 'unauthenticated', {}],
        ['a guard’s 403 before the action', 403, 'forbidden', {}],
        [
            'a refusal the action returned that says nothing of who is signed in',
            422,
            'validation',
            { expected: true, execution: 'entered' },
        ],
        ['input that did not bind, said by nobody', 422, 'validation', {}],
        [
            'a refusal that says someone else is signed in',
            422,
            'validation',
            { auth: { ...now, partition: 'someone-else' } },
        ],
        ['a refusal of another browser context', 422, 'validation', { auth: { ...now, context: 'other' } }],
        [
            'a refusal whose word of who is signed in is of another release',
            422,
            'validation',
            { auth: now, respondingBuild: 'old' },
        ],
        [
            'a refusal whose word of who is signed in is malformed',
            422,
            'validation',
            { auth: { context: 'ctx' } },
        ],
    ] as const)(
        'closes the page and settles who is signed in after %s',
        async (_what, status, code, said) => {
            const { test, scope, result, settle } = await login(
                refusal(status, code, { execution: 'not-entered', schema: 'sl', ...said }),
            );
            // The refusal is the caller's as it was; the page is closed in the same turn.
            expect(result).toMatchObject({ ok: false, problem: { status, code } });
            expect(test.snapshot()).toMatchObject({ reconciling: true, page: null });
            expect(test.runtime.writable()).toBe(false);
            await expect(
                test.runtime.act(test.runtime.bind('p', 'save', scope), { json: {} }),
            ).rejects.toMatchObject({ kind: 'auth', outcome: 'not-sent' });
            await settle('as who is signed in now');
            expect(test.data()).toBe('as who is signed in now');
            expect(test.runtime.writable()).toBe(true);
            // The action was sent once, and the page was read once to settle it.
            expect(posts(test)).toBe(1);
            expect(test.requests.filter(request => request.method === 'GET')).toHaveLength(1);
        },
    );

    it.each([
        ['a failure the action returned', { expected: true, execution: 'entered' }],
        ['input that did not bind', { execution: 'not-entered' }],
    ] as const)(
        'keeps the page as it is after %s that says who the page knows is still signed in',
        async (_what, said) => {
            const { test, result } = await login(
                refusal(422, 'validation', { schema: 'sl', auth: now, ...said }),
            );
            expect(result).toMatchObject({ ok: false, problem: { status: 422 } });
            expect(test.snapshot().reconciling).toBe(false);
            expect(test.data()).toBe('initial');
            expect(test.runtime.writable()).toBe(true);
            expect(test.requests.filter(request => request.method === 'GET')).toHaveLength(0);
        },
    );

    it('takes the revision a refusal says was reached, and settles the page as nothing older', async () => {
        const moved = { ...now, revision: '6' };
        const { test, result } = await login(
            refusal(422, 'validation', { expected: true, execution: 'entered', schema: 'sl', auth: moved }),
        );
        expect(result).toMatchObject({ ok: false, problem: { status: 422 } });
        expect(test.snapshot()).toMatchObject({ reconciling: true, page: null });
        expect(test.runtime.writable()).toBe(false);
        expect(test.runtime.auth).toEqual(moved);
        expect(posts(test)).toBe(1);
    });

    it('settles it too where the page was told nothing of who is signed in', async () => {
        const { test, result, settle } = await login(
            refusal(401, 'unauthenticated', { execution: 'not-entered', schema: 'sl' }),
            undefined,
        );
        expect(result).toMatchObject({ ok: false });
        expect(test.snapshot().reconciling).toBe(true);
        await settle('settled');
        expect(posts(test)).toBe(1);
    });

    it('does none of this for an action that changes nobody: its refusal is a result', async () => {
        const test = await app({ auth: now });
        test.serve(() => refusal(403, 'forbidden', { execution: 'not-entered' }));
        expect(
            await test.runtime.act(test.runtime.bind('p', 'save', test.scope()), { json: {} }),
        ).toMatchObject({ ok: false });
        expect(test.snapshot().reconciling).toBe(false);
        expect(test.runtime.writable()).toBe(true);
    });
});

describe('R3: a failure the server did not write on purpose is no refusal, of a read no more than of a write', () => {
    it.each([
        ['a 422 a query threw', 422, 'validation'],
        ['a 404 a middleware answered with after it', 404, 'not_found'],
    ])('gives %s as a failure of the server, not as a refusal of the query', async (_what, status, code) => {
        const test = await app();
        test.serve(() => refusal(status, code, { execution: 'entered', expected: false, schema: 'sq' }));
        const failure = await test.runtime
            .read(test.runtime.bind('p', 'q', test.scope()), {})
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(RequestFailure);
        expect(failure).not.toBeInstanceOf(QueryProblem);
        expect(failure).toMatchObject({ kind: 'server', outcome: 'rejected', status });
    });

    it('does the same when the server does not say whether it was expected', async () => {
        const test = await app();
        test.serve(() => refusal(422, 'validation', { execution: 'entered', schema: 'sq' }));
        await expect(test.runtime.read(test.runtime.bind('p', 'q', test.scope()), {})).rejects.toMatchObject({
            kind: 'server',
        });
    });

    it.each([
        ['a failure the query returned', { execution: 'entered', expected: true }],
        ['a refusal before the query', { execution: 'not-entered' }],
    ] as const)('keeps %s a refusal of the query', async (_what, said) => {
        const test = await app();
        test.serve(() => refusal(403, 'forbidden', { ...said, schema: 'sq' }));
        const failure = await test.runtime
            .read(test.runtime.bind('p', 'q', test.scope()), {})
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(QueryProblem);
        expect(failure).toMatchObject({ problem: { status: 403, code: 'forbidden' } });
    });

    it('does not show a page for a failure a loader threw: the navigation fails, and the page shown stays', async () => {
        const test = await app();
        test.serve(() => refusal(404, 'not_found', { execution: 'entered', expected: false, schema: 'nav' }));
        const result = await test.runtime.router.navigate('/two');
        expect(result).toMatchObject({
            status: 'failed',
            error: { href: '/two', failure: { kind: 'server', status: 404, outcome: 'rejected' } },
        });
        expect(test.data()).toBe('initial');
        expect(test.snapshot().page!.problem ?? null).toBeNull();
    });
});

describe('R1-C04: a page that failed part way shows the layouts’ data only as whose it is', () => {
    const now: AuthSnapshot = { context: 'ctx', revision: '5', partition: 'new-user' };
    const partial = (auth?: AuthSnapshot): Record<string, unknown> => {
        const {
            protocol: _protocol,
            kind: _kind,
            ...rest
        } = pageEnvelope('two', 'a layout’s private data', auth);
        return rest;
    };

    it('shows it when it says it is the same person’s', async () => {
        const test = await app({ auth: now });
        test.serve(() =>
            refusal(404, 'not_found', { expected: true, schema: 'nav', pageError: partial(now) }),
        );
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
        expect(test.snapshot().page!.problem).toMatchObject({ status: 404 });
        expect(test.data()).toBe('a layout’s private data');
        expect(test.snapshot().reconciling).toBe(false);
    });

    it.each([
        ['says nothing of whose it is', undefined],
        ['is of whoever was signed in before', { context: 'ctx', revision: '4', partition: 'old-user' }],
        ['is of someone else', { context: 'ctx', revision: '5', partition: 'someone-else' }],
    ])('does not show it when it %s, and settles who is signed in', async (_what, carried) => {
        const test = await app({ auth: now });
        const settled = deferred();
        test.serve(url =>
            url === '/two'
                ? refusal(404, 'not_found', {
                      expected: true,
                      schema: 'nav',
                      pageError: partial(carried as AuthSnapshot | undefined),
                  })
                : settled.promise,
        );
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'superseded' });
        expect(test.snapshot()).toMatchObject({ reconciling: true, page: null });
        expect(test.runtime.auth).toEqual(now);
        settled.resolve(page('one', 'settled', now));
        await test.runtime.router.reconciliation();
        expect(test.data()).toBe('settled');
    });

    it('shows it when the refusal itself says it is the same person’s, and settles nothing', async () => {
        const test = await app({ auth: now });
        const asked: string[] = [];
        test.serve(url => {
            asked.push(url);
            return refusal(404, 'not_found', {
                expected: true,
                schema: 'nav',
                pageError: partial(),
                auth: now,
            });
        });
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
        expect(test.data()).toBe('a layout’s private data');
        expect(test.snapshot().reconciling).toBe(false);
        expect(asked).toEqual(['/two']);
    });

    it.each([
        ['of another release', { respondingBuild: 'old' }],
        ['contradicted by what the data says of itself', { carried: { ...now, partition: 'someone-else' } }],
    ])('does not take the refusal’s word when it is %s', async (_what, made) => {
        const test = await app({ auth: now });
        const settled = deferred();
        test.serve(url =>
            url === '/two'
                ? refusal(404, 'not_found', {
                      expected: true,
                      schema: 'nav',
                      pageError: partial('carried' in made ? made.carried : undefined),
                      auth: now,
                      respondingBuild: 'respondingBuild' in made ? made.respondingBuild : undefined,
                  })
                : settled.promise,
        );
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'superseded' });
        expect(test.snapshot()).toMatchObject({ reconciling: true, page: null });
        settled.resolve(page('one', 'settled', now));
        await test.runtime.router.reconciliation();
    });

    it('shows a refusal that carries nobody’s data, with or without a word of who is signed in', async () => {
        const test = await app({ auth: now });
        test.serve(() => refusal(404, 'not_found', { execution: 'not-entered', schema: 'nav' }));
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
        expect(test.snapshot().page).toMatchObject({ problem: { status: 404 }, nodes: [] });
        expect(test.snapshot().reconciling).toBe(false);
    });

    it('shows it as before where the application tells nobody apart', async () => {
        const test = await app();
        test.serve(() => refusal(404, 'not_found', { expected: true, schema: 'nav', pageError: partial() }));
        expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
        expect(test.data()).toBe('a layout’s private data');
    });
});

describe('R2-C04: leaving the document keeps whether it takes the place of the entry shown', () => {
    const elsewhere = 'https://elsewhere.example/landing';

    it.each([
        ['an ordinary route of this site', '/ordinary', `${location.origin}/ordinary`],
        ['another site', elsewhere, elsewhere],
    ])('replaces for %s when asked to, and pushes when not', async (_what, to, absolute) => {
        const test = await app();
        expect(await test.runtime.router.navigate(to, { replace: true })).toMatchObject({
            status: 'document',
        });
        expect(await test.runtime.router.navigate(to)).toMatchObject({ status: 'document' });
        expect(await test.runtime.router.navigate(to, { replace: false })).toMatchObject({
            status: 'document',
        });
        expect(test.left).toEqual([absolute, absolute, absolute]);
        expect(test.replaced).toEqual([true, false, false]);
    });

    it('keeps it through a blocker, whether the attempt is let through or given up', async () => {
        const test = await app();
        const blocker = test.runtime.router.block(() => true);
        expect(await test.runtime.router.navigate('/ordinary', { replace: true })).toEqual({
            status: 'blocked',
        });
        expect(test.left).toEqual([]);
        expect(await blocker.proceed()).toMatchObject({ status: 'document' });
        expect(test.replaced).toEqual([true]);

        expect(await test.runtime.router.navigate(elsewhere, { replace: true })).toEqual({
            status: 'blocked',
        });
        blocker.reset();
        expect(await test.runtime.router.navigate(elsewhere)).toEqual({ status: 'blocked' });
        expect(await blocker.proceed()).toMatchObject({ status: 'document' });
        expect(test.left).toEqual([`${location.origin}/ordinary`, elsewhere]);
        expect(test.replaced).toEqual([true, false]);
        blocker.dispose();
    });

    it('keeps it through a loader’s redirect: of a replacing navigation it replaces, of a pushing one it pushes', async () => {
        const test = await app();
        test.serve(() => redirected('/ordinary', 'document'));
        expect(await test.runtime.router.navigate('/two', { replace: true })).toMatchObject({
            status: 'document',
        });
        expect(await test.runtime.router.navigate('/two')).toMatchObject({ status: 'document' });
        test.serve(() => redirected(elsewhere, 'document'));
        expect(await test.runtime.router.navigate('/three', { replace: true })).toMatchObject({
            status: 'document',
        });
        expect(test.replaced).toEqual([true, false, true]);
    });

    it('replaces when a refresh finds the page shown is somewhere else now: the entry that asked is the one left', async () => {
        const test = await app();
        test.serve(() => redirected('/ordinary', 'document'));
        await test.runtime.router.revalidate();
        expect(test.left).toEqual([`${location.origin}/ordinary`]);
        expect(test.replaced).toEqual([true]);
    });

    it('uses the browser’s own replace and assign where nothing else is given', async () => {
        const calls: [string, string][] = [];
        const real = window.location;
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: {
                ...real,
                href: real.href,
                origin: real.origin,
                assign: (href: string) => calls.push(['assign', href]),
                replace: (href: string) => calls.push(['replace', href]),
            },
        });
        try {
            const runtime = new Runtime({ manifest, build: 'b', transport: async () => page('one') });
            runtime.leave('/a', true);
            runtime.leave('/b', false);
            runtime.dispose();
        } finally {
            Object.defineProperty(window, 'location', { configurable: true, value: real });
        }
        expect(calls).toEqual([
            ['replace', '/a'],
            ['assign', '/b'],
        ]);
    });
});

describe('R2-C05: a step through history that is overtaken leaves the page and the address together', () => {
    const entry = (): { key: string; index: number } => {
        const own = (history.state as { psx: { key: string; index: number } }).psx;
        return { key: own.key, index: own.index };
    };
    const popped = (step: () => void): Promise<void> =>
        new Promise(resolve => {
            window.addEventListener('popstate', () => resolve(), { once: true });
            step();
        });
    /** /one, /two, /three, then Back to /two with its page held: the address moved, the page did not. */
    const overtaken = async (): Promise<{ test: Harness; back: Deferred<Response>; keys: string[] }> => {
        const test = await app();
        const keys = [entry().key];
        await test.runtime.router.navigate('/two');
        keys.push(entry().key);
        await test.runtime.router.navigate('/three');
        keys.push(entry().key);
        const back = deferred();
        let held = false;
        test.serve(url => {
            if (url === '/two' && !held) {
                held = true;
                return back.promise;
            }
            return byAddress(url, {});
        });
        await popped(() => history.back());
        expect(location.pathname).toBe('/two');
        expect(test.snapshot().pending).toEqual({ href: '/two' });
        expect(test.snapshot().page!.href).toBe('/three');
        return { test, back, keys };
    };
    const together = (test: Harness, href: string): void => {
        expect(location.pathname + location.search + location.hash).toBe(href);
        expect(test.snapshot().location.href).toBe(href);
        expect(test.snapshot().page!.href).toBe(href.split('#')[0]);
        expect(test.snapshot().location.entryKey).toBe(entry().key);
    };

    it('pushes after the entry the browser is at, and a blocked step back is put back where the page is', async () => {
        const { test, back, keys } = await overtaken();
        expect(await test.runtime.router.navigate('/one')).toEqual({ status: 'committed', href: '/one' });
        // After /two, which is index 1: not after /three, which the browser had left.
        expect(entry().index).toBe(2);
        together(test, '/one');

        const blocker = test.runtime.router.block(() => true);
        await popped(() => history.back());
        await vi.waitFor(() => together(test, '/one'));
        expect(blocker.getSnapshot()).toMatchObject({ href: '/two', type: 'pop' });
        // Let through, it goes where it was going.
        void blocker.proceed();
        await vi.waitFor(() => together(test, '/two'));
        expect(entry()).toEqual({ key: keys[1], index: 1 });
        // And forward again, blocked and put back.
        await popped(() => history.forward());
        await vi.waitFor(() => together(test, '/two'));
        blocker.reset();
        blocker.dispose();

        // The answer the overtaken step was waiting for says nothing any more.
        back.resolve(page('two', 'of the step that was overtaken'));
        await Promise.resolve();
        expect(test.data()).not.toBe('of the step that was overtaken');
    });

    it('replaces the entry the browser is at', async () => {
        const { test, keys } = await overtaken();
        expect(await test.runtime.router.navigate('/one', { replace: true })).toEqual({
            status: 'committed',
            href: '/one',
        });
        expect(entry()).toEqual({ key: keys[1], index: 1 });
        together(test, '/one');
        // What was after it is still after it.
        await popped(() => history.forward());
        await vi.waitFor(() => together(test, '/three'));
        expect(entry()).toEqual({ key: keys[2], index: 2 });
        await popped(() => history.go(-2));
        await vi.waitFor(() => together(test, '/one'));
        expect(entry().index).toBe(0);
    });

    it('puts the address back when what overtook it is held, and when it fails', async () => {
        const { test, keys } = await overtaken();
        const blocker = test.runtime.router.block(intent => intent.type !== 'pop');
        expect(await test.runtime.router.navigate('/one')).toEqual({ status: 'blocked' });
        await vi.waitFor(() => together(test, '/three'));
        expect(entry()).toEqual({ key: keys[2], index: 2 });
        blocker.reset();
        blocker.dispose();
        together(test, '/three');

        // Back again, overtaken by a navigation that fails.
        const again = deferred();
        test.serve(url => (url === '/two' ? again.promise : Promise.reject(new TypeError('offline'))));
        await popped(() => history.back());
        expect(location.pathname).toBe('/two');
        expect(await test.runtime.router.navigate('/one')).toMatchObject({ status: 'failed' });
        await vi.waitFor(() => together(test, '/three'));
        expect(entry()).toEqual({ key: keys[2], index: 2 });
        // A step back from there is a step back from /three.
        test.serve(byAddress);
        await popped(() => history.back());
        await vi.waitFor(() => together(test, '/two'));
        expect(entry()).toEqual({ key: keys[1], index: 1 });
    });

    it('moves to another place in the page from the entry the browser is at', async () => {
        const { test } = await overtaken();
        expect(await test.runtime.router.navigate('/three#part')).toEqual({
            status: 'committed',
            href: '/three#part',
        });
        expect(entry().index).toBe(2);
        together(test, '/three#part');
        await popped(() => history.back());
        await vi.waitFor(() => together(test, '/two'));
    });

    it('is overtaken the same way going forward', async () => {
        const test = await app();
        await test.runtime.router.navigate('/two');
        await test.runtime.router.navigate('/three');
        await popped(() => history.go(-2));
        await vi.waitFor(() => together(test, '/one'));
        const forward = deferred();
        test.serve(url => (url === '/two' ? forward.promise : byAddress(url, {})));
        await popped(() => history.forward());
        expect(location.pathname).toBe('/two');
        expect(test.snapshot().page!.href).toBe('/one');
        expect(await test.runtime.router.navigate('/three')).toEqual({ status: 'committed', href: '/three' });
        expect(entry().index).toBe(2);
        together(test, '/three');
        const blocker = test.runtime.router.block(() => true);
        await popped(() => history.back());
        await vi.waitFor(() => together(test, '/three'));
        blocker.reset();
        blocker.dispose();
    });

    it('leaves for a document from where the browser is, and moves nothing itself', async () => {
        const { test } = await overtaken();
        expect(await test.runtime.router.navigate('/ordinary')).toMatchObject({ status: 'document' });
        expect(test.left).toEqual([`${location.origin}/ordinary`]);
        expect(location.pathname).toBe('/two');
    });
});

describe('a place in the page the browser stepped to by itself is that page’s, and nothing is loaded for it', () => {
    const entry = (): { key: string; index: number } => {
        const own = (history.state as { psx: { key: string; index: number } }).psx;
        return { key: own.key, index: own.index };
    };
    const popped = (step: () => void): Promise<void> =>
        new Promise(resolve => {
            window.addEventListener('popstate', () => resolve(), { once: true });
            step();
        });
    const at = (): string => location.pathname + location.search + location.hash;

    it('takes a plain anchor’s entry as its own, after the one it was stepped from', async () => {
        const test = await app();
        await test.runtime.router.navigate('/two');
        const two = entry();
        const asked = test.requests.length;
        const shown = test.snapshot().page!;

        // What a plain <a href="#part"> does: an entry of the browser's, with no state.
        await popped(() => {
            location.hash = '#part';
        });
        expect(test.left).toEqual([]);
        expect(at()).toBe('/two#part');
        expect(entry().index).toBe(two.index + 1);
        expect(entry().key).not.toBe(two.key);
        expect(test.snapshot().location).toMatchObject({ href: '/two#part', entryKey: entry().key });
        expect(test.snapshot().page!.href).toBe(shown.href);
        expect(test.snapshot().page!.commit).toBe(shown.commit);

        // Back is the entry it came from, and forward the place again: neither asks the server.
        await popped(() => history.back());
        await vi.waitFor(() => expect(test.snapshot().location.href).toBe('/two'));
        expect(entry()).toEqual(two);
        await popped(() => history.forward());
        await vi.waitFor(() => expect(test.snapshot().location.href).toBe('/two#part'));
        expect(test.requests.length).toBe(asked);

        // What is pushed next follows it.
        expect(await test.runtime.router.navigate('/three')).toEqual({ status: 'committed', href: '/three' });
        expect(entry().index).toBe(two.index + 2);
    });

    it('starts a document opened at a place in its page at that place', async () => {
        for (const [href, scroll] of [
            ['/one#part', 'hash'],
            ['/one', 'none'],
        ] as const) {
            history.replaceState(null, '', href);
            const runtime = new Runtime({ manifest, build: 'b', transport: async url => byAddress(url, {}) });
            await runtime.router.install(pageEnvelope('one', 'initial'), href);
            expect(runtime.router.getSnapshot().page!.scroll).toBe(scroll);
            runtime.dispose();
        }
    });

    it('overtakes a navigation that was on its way', async () => {
        const test = await app();
        const slow = deferred();
        test.serve(url => (url === '/two' ? slow.promise : byAddress(url, {})));
        const going = test.runtime.router.navigate('/two');
        await vi.waitFor(() => expect(test.snapshot().pending).toEqual({ href: '/two' }));
        await popped(() => {
            location.hash = '#part';
        });
        expect(test.snapshot().pending).toBeNull();
        slow.resolve(await byAddress('/two', {}));
        expect(await going).toEqual({ status: 'superseded' });
        expect(at()).toBe('/one#part');
        expect(test.snapshot().page!.href).toBe('/one');
    });
});

describe('what a document arrived with is read once and not kept in it', () => {
    it('takes the data out of the document as the application starts', async () => {
        history.replaceState(null, '', '/one');
        const script = document.createElement('script');
        script.type = 'application/json';
        script.id = 'psx-bootstrap';
        script.textContent = JSON.stringify({
            envelope: pageEnvelope('one', 'private of whoever was signed in'),
            rendering: 'client',
            limits: {},
            development: false,
        });
        const root = document.createElement('div');
        document.body.append(root, script);
        const failures: Error[] = [];
        const started = start({ root, onError: error => failures.push(error) }, manifest);
        try {
            // Gone before anything is shown, and the page starts from what was read.
            expect(document.getElementById('psx-bootstrap')).toBeNull();
            expect(document.documentElement.outerHTML).not.toContain('private of whoever was signed in');
            await vi.waitFor(() => expect(history.state).toMatchObject({ psx: { index: 0 } }));
            await turn();
            expect(started.router.location.href).toBe('/one');
            expect(root.querySelector('[role="alert"]')).toBeNull();
            expect(failures).toEqual([]);
        } finally {
            started.dispose();
            root.remove();
            script.remove();
        }
    });
});

describe('READY-C01: what a document arrived with is shown only where nothing has taken its place', () => {
    const before: AuthSnapshot = { context: 'c', revision: '5', partition: 'previous-user' };
    const now: AuthSnapshot = { context: 'c', revision: '6', partition: 'current-user' };

    /** An application whose first page's code is held until the test lets it arrive, or fail. */
    function slow(): {
        runtime: Runtime;
        installing: Promise<boolean>;
        arrive: () => void;
        fail: () => void;
        errors: Error[];
        requests: string[];
        serve: (next: (url: string) => Response | Promise<Response>) => void;
    } {
        history.replaceState(null, '', '/one');
        const code = deferred<{ default: () => null }>();
        const errors: Error[] = [];
        const requests: string[] = [];
        let handler: (url: string) => Response | Promise<Response> = url =>
            page(url === '/two' ? 'two' : 'one', 'of who is signed in now', now);
        const held: Manifest = {
            ...manifest,
            modules: { p: async () => ({ default: () => null }), first: () => code.promise },
            routes: {
                ...manifest.routes,
                one: {
                    ...manifest.routes.one!,
                    nodes: [{ ...manifest.routes.one!.nodes[0]!, module: 'first' }],
                },
            },
        };
        const runtime = new Runtime({
            manifest: held,
            build: 'b',
            onError: error => errors.push(error),
            // A page whose code is gone asks for its document: the test has none to go to.
            leave: () => undefined,
            transport: async url => {
                requests.push(url);
                return handler(url);
            },
        });
        const first = pageEnvelope('one', 'private of who was signed in before', before);
        (first.nodes as { module: string }[])[0]!.module = 'first';
        const installing = runtime.router.install(first, '/one');
        // An answer of the server names the module as the manifest does.
        const named = (response: Response | Promise<Response>): Promise<Response> =>
            Promise.resolve(response).then(async answer => {
                const body = await answer.clone().json();
                if (body.kind === 'page' && body.route.id === 'one') {
                    body.nodes[0].module = 'first';
                    return new Response(JSON.stringify(body), {
                        status: answer.status,
                        headers: answer.headers,
                    });
                }
                return answer;
            });
        const inner = handler;
        handler = url => named(inner(url));
        return {
            runtime,
            installing,
            arrive: () => code.resolve({ default: () => null }),
            fail: () => code.reject(new Error('the chunk is gone')),
            errors,
            requests,
            serve: next => {
                handler = url => named(next(url));
            },
        };
    }
    const shown = (runtime: Runtime): unknown => runtime.router.getSnapshot().page?.nodes[0]?.data ?? null;
    /** The same person as the document was written for, at a later revision. */
    const later: AuthSnapshot = { ...before, revision: '6' };
    const popped = (step: () => void): Promise<void> =>
        new Promise(resolve => {
            window.addEventListener('popstate', () => resolve(), { once: true });
            step();
        });

    it('takes the document’s place in history, listens, and knows who it says is signed in before its code is there', async () => {
        const test = slow();
        try {
            expect(history.state).toMatchObject({ psx: { index: 0 } });
            expect(test.runtime.router.getSnapshot().location.href).toBe('/one');
            expect(test.runtime.auth).toEqual(before);
            expect(test.runtime.router.getSnapshot().page).toBeNull();
            test.arrive();
            expect(await test.installing).toBe(true);
            expect(shown(test.runtime)).toBe('private of who was signed in before');
            expect(test.runtime.auth).toEqual(before);
        } finally {
            test.runtime.dispose();
        }
    });

    for (const late of ['arrives', 'fails'] as const) {
        it(`keeps a newer page and what is known of who is signed in when the first page’s code ${late} late`, async () => {
            const test = slow();
            try {
                test.serve(url => page(url === '/two' ? 'two' : 'one', 'the same person, later', later));
                expect(await test.runtime.router.navigate('/two')).toEqual({
                    status: 'committed',
                    href: '/two',
                });
                expect(test.runtime.auth).toEqual(later);
                test[late === 'arrives' ? 'arrive' : 'fail']();
                expect(await test.installing).toBe(false);
                expect(location.pathname).toBe('/two');
                expect(test.runtime.router.getSnapshot().location.href).toBe('/two');
                expect(test.runtime.router.getSnapshot().page!.href).toBe('/two');
                expect(shown(test.runtime)).toBe('the same person, later');
                // What is known of who is signed in is not set back to what the document knew.
                expect(test.runtime.auth).toEqual(later);
                expect(test.errors.map(error => error.message)).toEqual(
                    late === 'fails' ? ['A part of the page could not be loaded. Reload the page.'] : [],
                );
                // Back is listened for, though the first page never showed: its entry is read anew.
                await popped(() => history.back());
                await vi.waitFor(() => expect(test.requests).toEqual(['/two', '/one']));
                if (late === 'arrives') {
                    await vi.waitFor(() => expect(test.runtime.router.getSnapshot().page?.href).toBe('/one'));
                    expect(shown(test.runtime)).toBe('the same person, later');
                }
                expect(test.runtime.auth).toEqual(later);
            } finally {
                test.runtime.dispose();
            }
        });

        it(`settles who is signed in when a navigation is answered as someone else, and the first page’s code ${late} late`, async () => {
            const test = slow();
            try {
                // The document knew revision 5 of one person; the navigation is answered as another.
                // It is no page of the person the document was for: who is signed in is settled, at
                // the address the browser is at, and neither that answer nor the document's is shown.
                expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'superseded' });
                expect(test.runtime.router.getSnapshot().reconciling).toBe(true);
                test[late === 'arrives' ? 'arrive' : 'fail']();
                expect(await test.installing).toBe(false);
                expect(shown(test.runtime)).not.toBe('private of who was signed in before');
                const settled = await test.runtime.router.reconciliation();
                if (late === 'arrives') {
                    expect(settled).toMatchObject({ status: 'reconciled' });
                    expect(location.pathname).toBe('/one');
                    expect(shown(test.runtime)).toBe('of who is signed in now');
                    expect(test.runtime.auth).toEqual(now);
                } else {
                    expect(settled).toEqual({ status: 'document-required', origin: null });
                    expect(shown(test.runtime)).toBeNull();
                }
                expect(test.runtime.auth?.revision).not.toBe('5');
            } finally {
                test.runtime.dispose();
            }
        });

        it(`shows nothing of before when who is signed in changed and the first page’s code ${late} late`, async () => {
            const test = slow();
            try {
                const answer = deferred();
                test.serve(() => answer.promise);
                const settling = test.runtime.authChanged(false);
                expect(test.runtime.router.getSnapshot().reconciling).toBe(true);
                // The page is read again at the document's own address, not at one the router made up.
                await vi.waitFor(() => expect(test.requests).toEqual(['/one']));
                test[late === 'arrives' ? 'arrive' : 'fail']();
                expect(await test.installing).toBe(false);
                // Still settling: the document's page, of whoever was signed in, is not shown meanwhile.
                expect(test.runtime.router.getSnapshot().reconciling).toBe(true);
                expect(shown(test.runtime)).toBeNull();
                expect(test.runtime.auth).toEqual(before);
                if (late === 'arrives') {
                    answer.resolve(page('one', 'of who is signed in now', now));
                    expect(await settling).toMatchObject({ status: 'reconciled' });
                    expect(shown(test.runtime)).toBe('of who is signed in now');
                    expect(test.runtime.auth).toEqual(now);
                } else {
                    // The code of the page is gone for the settling too: only a document can show it.
                    answer.resolve(page('one', 'of who is signed in now', now));
                    expect(await settling).toEqual({ status: 'document-required', origin: null });
                    expect(shown(test.runtime)).toBeNull();
                }
            } finally {
                test.runtime.dispose();
            }
        });

        it(`does nothing once the application was closed, when the first page’s code ${late} late`, async () => {
            const test = slow();
            test.runtime.dispose();
            test[late === 'arrives' ? 'arrive' : 'fail']();
            expect(await test.installing).toBe(false);
            expect(test.runtime.router.getSnapshot().page).toBeNull();
            expect(test.runtime.auth).toEqual(before);
            expect(test.errors).toEqual([]);
            expect(test.requests).toEqual([]);
        });
    }

    it('still cannot start when the first page’s code fails and nothing newer was asked for', async () => {
        const test = slow();
        try {
            test.fail();
            await expect(test.installing).rejects.toMatchObject({ kind: 'build' });
            expect(test.runtime.router.getSnapshot().page).toBeNull();
        } finally {
            test.runtime.dispose();
        }
    });

    it('shows the document’s page under a navigation that is still on its way, which then goes on', async () => {
        const test = slow();
        try {
            const answer = deferred();
            test.serve(() => answer.promise);
            const going = test.runtime.router.navigate('/two');
            await vi.waitFor(() =>
                expect(test.runtime.router.getSnapshot().pending).toEqual({ href: '/two' }),
            );
            test.arrive();
            expect(await test.installing).toBe(true);
            // The page of the address the browser is still at, being left: its origin is not current.
            expect(shown(test.runtime)).toBe('private of who was signed in before');
            expect(location.pathname).toBe('/one');
            expect(test.runtime.router.current(test.runtime.router.getSnapshot().page!.origin)).toBe(false);
            answer.resolve(page('two', 'the same person, later', before));
            expect(await going).toEqual({ status: 'committed', href: '/two' });
            expect(shown(test.runtime)).toBe('the same person, later');
            expect(location.pathname).toBe('/two');
        } finally {
            test.runtime.dispose();
        }
    });

    it('shows the document’s page, as the current one, after a navigation that came to nothing', async () => {
        const test = slow();
        try {
            test.serve(() => {
                throw new TypeError('offline');
            });
            expect((await test.runtime.router.navigate('/two')).status).toBe('failed');
            expect(location.pathname).toBe('/one');
            test.arrive();
            expect(await test.installing).toBe(true);
            expect(shown(test.runtime)).toBe('private of who was signed in before');
            expect(test.runtime.router.current(test.runtime.router.getSnapshot().page!.origin)).toBe(true);
            // And a later navigation is as any other.
            test.serve(() => page('two', 'the same person, later', before));
            expect(await test.runtime.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
        } finally {
            test.runtime.dispose();
        }
    });

    it('renders the newer page anew instead of hydrating the server’s markup of the first', async () => {
        history.replaceState(null, '', '/one');
        const code = deferred<{ default: () => ReturnType<typeof createElement> }>();
        const shows = (text: string) => ({ default: () => createElement('main', null, text) });
        const held: Manifest = {
            ...manifest,
            modules: { p: async () => shows('the newer page'), first: () => code.promise },
            routes: {
                ...manifest.routes,
                one: {
                    ...manifest.routes.one!,
                    nodes: [{ ...manifest.routes.one!.nodes[0]!, module: 'first' }],
                },
            },
        };
        const first = pageEnvelope('one', 'private of who was signed in before', before);
        (first.nodes as { module: string }[])[0]!.module = 'first';
        const script = document.createElement('script');
        script.type = 'application/json';
        script.id = 'psx-bootstrap';
        script.textContent = JSON.stringify({
            envelope: first,
            rendering: 'server',
            limits: {},
            development: false,
        });
        const root = document.createElement('div');
        root.innerHTML = '<main>the server’s markup of the first page</main>';
        document.body.append(root, script);
        vi.stubGlobal('fetch', async () => page('two', 'the same person, later', later));
        const told: string[] = [];
        const started = start(
            { root, onError: (error, context) => told.push(`${context.kind}: ${error.message}`) },
            held,
        );
        try {
            expect(await started.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
            // READY-C02: shown while the first page's code is still on its way, not after it.
            await vi.waitFor(() => expect(root.textContent).toBe('the newer page'));
            expect(document.documentElement.outerHTML).not.toContain('the server’s markup of the first page');
            const made = root.firstElementChild;
            code.resolve(shows('the first page'));
            await turn();
            await turn();
            expect(root.textContent).toBe('the newer page');
            // The one application, mounted once: what it rendered is still the same element.
            expect(root.firstElementChild).toBe(made);
            expect(location.pathname).toBe('/two');
            expect(told).toEqual([]);
        } finally {
            started.dispose();
            root.remove();
            script.remove();
            vi.unstubAllGlobals();
        }
    });

    it('takes the server’s markup of the first page out the moment who is signed in comes into question', async () => {
        history.replaceState(null, '', '/one');
        const code = deferred<{ default: () => ReturnType<typeof createElement> }>();
        const shows = (text: string) => ({ default: () => createElement('main', null, text) });
        const held: Manifest = {
            ...manifest,
            modules: { p: async () => shows('unused'), first: () => code.promise },
            routes: {
                ...manifest.routes,
                one: {
                    ...manifest.routes.one!,
                    nodes: [{ ...manifest.routes.one!.nodes[0]!, module: 'first' }],
                },
            },
        };
        const first = pageEnvelope('one', 'private of who was signed in before', before);
        (first.nodes as { module: string }[])[0]!.module = 'first';
        const script = document.createElement('script');
        script.type = 'application/json';
        script.id = 'psx-bootstrap';
        script.textContent = JSON.stringify({
            envelope: first,
            rendering: 'server',
            limits: {},
            development: false,
        });
        const root = document.createElement('div');
        root.innerHTML = '<main>private of who was signed in before</main>';
        document.body.append(root, script);
        const answer = deferred();
        vi.stubGlobal('fetch', () => answer.promise);
        const started = start({ root }, held);
        try {
            expect(root.textContent).toBe('private of who was signed in before');
            const settling = started.authChanged();
            // At once, before the page's code or the new answer is there.
            expect(root.textContent).toBe('');
            expect(document.documentElement.outerHTML).not.toContain('private of who was signed in before');
            // READY-C02: and the wait is said, while the first page's code is still on its way.
            await vi.waitFor(() => expect(root.querySelector('main[role="status"]')).not.toBeNull());
            code.resolve({ default: () => createElement('main', null, 'whoever the page is of') });
            await turn();
            expect(document.documentElement.outerHTML).not.toContain('private of who was signed in before');
            const again = pageEnvelope('one', 'of who is signed in now', now);
            (again.nodes as { module: string }[])[0]!.module = 'first';
            answer.resolve(globalAnswer(again, 'nav'));
            expect(await settling).toMatchObject({ status: 'reconciled' });
            await vi.waitFor(() => expect(root.textContent).toBe('whoever the page is of'));
        } finally {
            started.dispose();
            root.remove();
            script.remove();
            vi.unstubAllGlobals();
        }
    });

    const firstPage = { default: () => createElement('article', null, 'the first page') };

    /** A document the server rendered, whose page's code arrives when the test says. */
    async function served(rendered: { default: () => ReturnType<typeof createElement> } = firstPage) {
        history.replaceState(null, '', '/one');
        const code = deferred<{ default: () => ReturnType<typeof createElement> }>();
        const held: Manifest = {
            ...manifest,
            modules: {
                p: async () => ({ default: () => createElement('main', null, 'the newer page') }),
                first: () => code.promise,
            },
            routes: {
                ...manifest.routes,
                one: {
                    ...manifest.routes.one!,
                    nodes: [{ ...manifest.routes.one!.nodes[0]!, module: 'first' }],
                },
            },
        };
        const first = pageEnvelope('one', 'the first page', before);
        (first.nodes as { module: string }[])[0]!.module = 'first';
        const script = document.createElement('script');
        script.type = 'application/json';
        script.id = 'psx-bootstrap';
        script.textContent = JSON.stringify({
            envelope: first,
            rendering: 'server',
            limits: {},
            development: false,
        });
        const root = document.createElement('div');
        // What the server's renderer writes for that page, with the same code.
        root.innerHTML = await renderPage(
            { ...held, modules: { ...held.modules, first: async () => rendered } },
            first as unknown as PageEnvelope,
        );
        document.body.append(root, script);
        const told: string[] = [];
        const started = start(
            { root, onError: (error, context) => told.push(`${context.kind}: ${error.message}`) },
            held,
        );
        return {
            code,
            written: root.querySelector('article')!,
            root,
            told,
            started,
            close: () => {
                started.dispose();
                root.remove();
                script.remove();
                vi.unstubAllGlobals();
            },
        };
    }

    it('READY-C02: keeps the server’s markup and hydrates it, where the first page is the one that starts', async () => {
        const test = await served();
        try {
            expect(test.written.textContent).toBe('the first page');
            // Until its code is there, the server's markup is what is shown.
            await turn();
            expect(test.root.querySelector('article')).toBe(test.written);
            test.code.resolve(firstPage);
            await turn();
            await turn();
            // Hydrated: the element the server wrote is the one the application owns.
            expect(test.root.querySelector('article')).toBe(test.written);
            expect(test.root.textContent).toBe('the first page');
            expect(test.told).toEqual([]);
            // And the one root moves on with it.
            vi.stubGlobal('fetch', async () => page('two', 'the same person, later', before));
            expect(await test.started.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
            await vi.waitFor(() => expect(test.root.textContent).toBe('the newer page'));
            expect(test.root.querySelector('article')).toBeNull();
        } finally {
            test.close();
        }
    });

    it('READY-C02: shows the newer page though the first page’s code fails, or never comes', async () => {
        for (const ending of ['fails', 'never comes'] as const) {
            const test = await served();
            try {
                vi.stubGlobal('fetch', async () => page('two', 'the same person, later', before));
                expect(await test.started.router.navigate('/two')).toEqual({
                    status: 'committed',
                    href: '/two',
                });
                await vi.waitFor(() => expect(test.root.textContent).toBe('the newer page'));
                if (ending === 'fails') {
                    test.code.reject(new Error('the chunk is gone'));
                }
                await turn();
                await turn();
                // Nothing of the failure takes the page's place, and it is said once.
                expect(test.root.textContent).toBe('the newer page');
                expect(test.root.querySelector('[role="alert"]')).toBeNull();
                expect(test.told.length).toBe(ending === 'fails' ? 1 : 0);
                expect(location.pathname).toBe('/two');
            } finally {
                test.close();
            }
        }
    });

    it('READY-C03: a navigation that failed before the first page started is said beside the markup taken over, without a complaint', async () => {
        const test = await served();
        try {
            const answer = deferred();
            vi.stubGlobal('fetch', () => answer.promise);
            const going = test.started.router.navigate('/two');
            await turn();
            // Nothing newer is shown yet: the server's markup stays, untouched.
            expect(test.root.querySelector('article')).toBe(test.written);
            expect(test.started.router.pending).not.toBeNull();
            answer.reject(new TypeError('the network is gone'));
            expect(await going).toMatchObject({ status: 'failed' });
            await turn();
            expect(test.root.querySelector('article')).toBe(test.written);
            test.code.resolve(firstPage);
            await vi.waitFor(() =>
                expect(test.root.querySelector('[data-psx-navigation-error]')).not.toBeNull(),
            );
            // Taken over as the server wrote it, the very element, and only then told of the failure.
            expect(test.root.querySelector('article')).toBe(test.written);
            expect(test.told).toEqual([]);
            expect(test.started.router.navigationError).not.toBeNull();
            expect(location.pathname).toBe('/one');
            // Put away, it is gone, and the page moves on as any other.
            test.started.router.navigationError!.dismiss();
            await vi.waitFor(() => expect(test.root.querySelector('[data-psx-navigation-error]')).toBeNull());
            expect(test.root.querySelector('article')).toBe(test.written);
            vi.stubGlobal('fetch', async () => page('two', 'the same person, later', before));
            expect(await test.started.router.navigate('/two')).toEqual({ status: 'committed', href: '/two' });
            await vi.waitFor(() => expect(test.root.textContent).toBe('the newer page'));
            expect(test.told).toEqual([]);
        } finally {
            test.close();
        }
    });

    it('READY-C03: a navigation still on its way when the first page starts leaves its markup to be taken over, and then shows', async () => {
        const test = await served();
        try {
            const answer = deferred();
            vi.stubGlobal('fetch', () => answer.promise);
            const going = test.started.router.navigate('/two');
            await turn();
            expect(test.started.router.pending).not.toBeNull();
            test.code.resolve(firstPage);
            await turn();
            await turn();
            // Taken over while the navigation is still on its way: the element the server wrote.
            expect(test.root.querySelector('article')).toBe(test.written);
            expect(test.started.router.pending).toMatchObject({ href: '/two' });
            expect(test.told).toEqual([]);
            expect(location.pathname).toBe('/one');
            answer.resolve(page('two', 'the same person, later', before));
            expect(await going).toEqual({ status: 'committed', href: '/two' });
            await vi.waitFor(() => expect(test.root.textContent).toBe('the newer page'));
            expect(location.pathname).toBe('/two');
            expect(test.told).toEqual([]);
        } finally {
            test.close();
        }
    });

    it('READY-C03: a component reading the router is taken over as the server rendered it, and hears of what is on its way after', async () => {
        const renders: (string | null)[] = [];
        const Reads = (): ReturnType<typeof createElement> => {
            const pending = useRouter().pending;
            renders.push(pending === null ? null : pending.href);
            return createElement(
                'article',
                null,
                pending === null ? 'the first page' : 'the first page, leaving',
            );
        };
        const test = await served({ default: Reads });
        try {
            renders.length = 0;
            const answer = deferred();
            vi.stubGlobal('fetch', () => answer.promise);
            const going = test.started.router.navigate('/two');
            await turn();
            test.code.resolve({ default: Reads });
            await vi.waitFor(() => expect(test.root.textContent).toBe('the first page, leaving'));
            // First as the server had it, then as it is: the same element throughout.
            expect(renders[0]).toBeNull();
            expect(renders.at(-1)).toBe('/two');
            expect(test.root.querySelector('article')).toBe(test.written);
            expect(test.told).toEqual([]);
            answer.resolve(page('two', 'the same person, later', before));
            expect(await going).toEqual({ status: 'committed', href: '/two' });
            await vi.waitFor(() => expect(test.root.textContent).toBe('the newer page'));
            expect(test.told).toEqual([]);
        } finally {
            test.close();
        }
    });

    it('READY-C02: closed while the first page’s code is on its way, mounts nothing after', async () => {
        const test = await served();
        const listening = vi.spyOn(window, 'removeEventListener');
        try {
            test.started.dispose();
            expect(listening.mock.calls.some(([type]) => type === 'popstate')).toBe(true);
            test.code.resolve({ default: () => createElement('article', null, 'mounted after all') });
            await turn();
            await turn();
            expect(test.root.querySelector('article')).toBe(test.written);
            expect(test.root.textContent).toBe('the first page');
            expect(test.told).toEqual([]);
        } finally {
            listening.mockRestore();
            test.close();
        }
    });

    it('reads the page again instead of showing the document’s, when an answer since told of a later revision', async () => {
        const test = slow();
        try {
            // An answer that came to nothing as a page, but said who is signed in, later than the document knew.
            const newer: AuthSnapshot = { ...before, revision: '7' };
            test.runtime.witness(newer);
            expect(test.runtime.auth).toEqual(newer);
            test.serve(() => page('one', 'as of the later revision', newer));
            test.arrive();
            expect(await test.installing).toBe(false);
            await vi.waitFor(() => expect(shown(test.runtime)).toBe('as of the later revision'));
            expect(test.runtime.auth).toEqual(newer);
        } finally {
            test.runtime.dispose();
        }
    });
});

describe('READY-C04: what is kept of queries and what is read ahead are bounded, and neither outlives what it was read for', () => {
    const numbered = (data: string): Response => queried(data);
    /** An entry nobody watches, holding an answer of so many characters. */
    async function kept(test: Harness, n: number, data = `answer ${n}`) {
        test.serve(() => numbered(data));
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), { n });
        await test.runtime.queries.fetch(entry);
        return entry;
    }
    const has = (test: Harness, n: number): boolean =>
        test.runtime.queries.snapshot(
            test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), { n }),
        ).status === 'success';
    const asked = (test: Harness, address: string): number =>
        test.requests.filter(request => request.url === address).length;

    it('keeps no more entries than it may, dropping what was used longest ago and nothing that is watched', async () => {
        const test = await app({ limits: { queryCacheEntries: 3 } });
        const watched = await kept(test, 0);
        const leave = test.runtime.queries.subscribe(watched, () => undefined, { staleTime: 60_000 });
        for (let n = 1; n <= 6; n++) {
            await kept(test, n);
            expect(test.runtime.queries.size).toBeLessThanOrEqual(3);
        }
        // The watched one, and the two used last.
        expect(test.runtime.queries.snapshot(watched)).toMatchObject({ status: 'success', data: 'answer 0' });
        expect(test.runtime.queries.size).toBe(3);
        expect([5, 6].map(n => has(test, n))).toEqual([true, true]);
        // Asking after one that was dropped makes it anew, empty, and another makes room for it.
        expect(has(test, 1)).toBe(false);
        expect(test.runtime.queries.size).toBe(3);
        expect(test.runtime.queries.snapshot(watched).data).toBe('answer 0');
        leave();
    });

    it('keeps no more bytes than it may, and what is watched stays though it is over', async () => {
        const test = await app({ limits: { queryCacheBytes: 150 } });
        const long = 'x'.repeat(98);
        await kept(test, 1, long);
        expect(test.runtime.queries.size).toBe(1);
        await kept(test, 2, long);
        // Two are over what may be kept: the earlier is dropped.
        expect(test.runtime.queries.size).toBe(1);
        expect(has(test, 2)).toBe(true);
        expect(test.runtime.queries.size).toBe(1);

        // Watched, both stay, over the limit as they are; let go, they are held to it again.
        const first = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), { n: 2 });
        const leaveFirst = test.runtime.queries.subscribe(first, () => undefined, { staleTime: 60_000 });
        const second = await kept(test, 3, long);
        const leaveSecond = test.runtime.queries.subscribe(second, () => undefined, { staleTime: 60_000 });
        await kept(test, 4, long);
        expect(test.runtime.queries.snapshot(first).data).toBe(long);
        expect(test.runtime.queries.snapshot(second).data).toBe(long);
        leaveFirst();
        leaveSecond();
        await kept(test, 5, long);
        expect(test.runtime.queries.size).toBe(1);
    });

    it('drops an entry a while after its last reader left, and keeps it for a reader that returns before', async () => {
        const test = await app({ limits: { queryCacheGcSeconds: 0.05 } });
        const entry = await kept(test, 1);
        const before = test.requests.length;
        test.runtime.queries.subscribe(entry, () => undefined, { staleTime: 60_000 })();
        await new Promise(resolve => setTimeout(resolve, 20));
        // Back in time: the entry, its answer, and no request for it.
        const leave = test.runtime.queries.subscribe(entry, () => undefined, { staleTime: 60_000 });
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(test.runtime.queries.size).toBe(1);
        expect(test.runtime.queries.snapshot(entry).data).toBe('answer 1');
        expect(test.requests.length).toBe(before);
        leave();
        await vi.waitFor(() => expect(test.runtime.queries.size).toBe(0));
        // Whoever reads it next starts from nothing.
        expect(has(test, 1)).toBe(false);
    });

    it('does not let the wait of an entry that was dropped take away the entry made after it', async () => {
        const test = await app({ limits: { queryCacheEntries: 1, queryCacheGcSeconds: 0.05 } });
        // Read and let go: it waits to be dropped. Another is made, and it is dropped at once instead.
        const first = await kept(test, 1);
        test.runtime.queries.subscribe(first, () => undefined, { staleTime: 60_000 })();
        await kept(test, 2);
        expect(test.runtime.queries.size).toBe(1);
        // The same query is read again, by a reader that stays.
        const again = await kept(test, 1, 'read again');
        expect(again).not.toBe(first);
        const told: number[] = [];
        const leave = test.runtime.queries.subscribe(again, () => told.push(1), { staleTime: 60_000 });
        await new Promise(resolve => setTimeout(resolve, 120));
        // The first one's wait is over: the one being read is still the cache's.
        expect(test.runtime.queries.size).toBe(1);
        const before = test.requests.length;
        test.serve(() => numbered('after the change'));
        await test.runtime.queries.invalidate();
        expect(test.requests.length).toBe(before + 1);
        expect(test.runtime.queries.snapshot(again).data).toBe('after the change');
        leave();
    });

    it('shows nothing of an answer that comes after its last reader left, and the next reader asks for itself', async () => {
        const test = await app();
        const late = deferred();
        // A transport that answers all the same, cancelled or not.
        test.serve(() => late.promise);
        const entry = test.runtime.queries.entry(test.runtime.bind('p', 'q', test.scope()), { n: 1 });
        test.runtime.queries.subscribe(entry, () => undefined, {})();
        await turn();
        expect(test.runtime.queries.snapshot(entry)).toMatchObject({ status: 'pending', isFetching: false });
        late.resolve(numbered('asked for by one who left'));
        await turn();
        await turn();
        expect(test.runtime.queries.snapshot(entry)).toMatchObject({ status: 'pending', isFetching: false });
        expect(entry.bytes).toBe(0);
        const before = test.requests.length;
        test.serve(() => numbered('asked for by one who is here'));
        const leave = test.runtime.queries.subscribe(entry, () => undefined, {});
        await vi.waitFor(() =>
            expect(test.runtime.queries.snapshot(entry).data).toBe('asked for by one who is here'),
        );
        expect(test.requests.length).toBe(before + 1);
        leave();
    });

    it('keeps no more pages read ahead than twenty, the earliest dropped', async () => {
        const test = await app();
        test.serve(url => page('two', `ahead of ${url}`));
        for (let n = 0; n < 25; n++) {
            await test.runtime.router.prefetch(`/two?n=${n}`);
        }
        const ahead = (test.runtime.router as unknown as { prefetched: Map<string, unknown> }).prefetched;
        expect(ahead.size).toBe(20);
        expect([...ahead.keys()][0]).toBe('/two?n=5');
        // The last is shown from what was read ahead; the first is asked for again.
        expect(await test.runtime.router.navigate('/two?n=24')).toMatchObject({ status: 'committed' });
        expect(asked(test, '/two?n=24')).toBe(1);
        expect(ahead.size).toBe(19);
        expect(await test.runtime.router.navigate('/two?n=0')).toMatchObject({ status: 'committed' });
        expect(asked(test, '/two?n=0')).toBe(2);
    });

    it('does not show a page read ahead longer ago than it may be kept', async () => {
        const test = await app({ limits: { prefetchTtlSeconds: 0.05 } });
        test.serve(() => page('two', 'read ahead'));
        await test.runtime.router.prefetch('/two');
        await new Promise(resolve => setTimeout(resolve, 80));
        test.serve(() => page('two', 'read now'));
        expect(await test.runtime.router.navigate('/two')).toMatchObject({ status: 'committed' });
        expect(test.data()).toBe('read now');
        expect(asked(test, '/two')).toBe(2);
    });

    it('does not show a page read ahead of a write, whether it was answered before the write or after', async () => {
        for (const outcome of ['done', 'unknown'] as const) {
            const test = await app();
            const save = test.runtime.bind('p', 'save', test.scope());
            // One page read ahead and answered; another still on its way when the write is sent.
            test.serve(() => page('two', 'as it was before the write'));
            await test.runtime.router.prefetch('/two');
            const slow = deferred();
            test.serve(() => slow.promise);
            const reading = test.runtime.router.prefetch('/three');
            test.serve((_url, init) => {
                if (init.method !== 'POST') {
                    return page('one', 'refreshed');
                }
                if (outcome === 'unknown') {
                    throw new TypeError('the network is gone');
                }
                return acted('sa');
            });
            const written = test.runtime.act(save, { json: {} });
            if (outcome === 'done') {
                expect(await written).toMatchObject({ ok: true });
            } else {
                await expect(written).rejects.toMatchObject({ outcome: 'unknown' });
            }
            const ahead = (test.runtime.router as unknown as { prefetched: Map<string, unknown> }).prefetched;
            expect(ahead.size).toBe(0);
            slow.resolve(page('three', 'read while the write was on its way'));
            await reading;
            expect(ahead.size).toBe(0);

            test.serve(url => page(url === '/two' ? 'two' : 'three', 'as it is after the write'));
            expect(await test.runtime.router.navigate('/two')).toMatchObject({ status: 'committed' });
            expect(test.data()).toBe('as it is after the write');
            expect(asked(test, '/two')).toBe(2);
            expect(await test.runtime.router.navigate('/three')).toMatchObject({ status: 'committed' });
            expect(test.data()).toBe('as it is after the write');
            expect(asked(test, '/three')).toBe(2);
            test.runtime.dispose();
        }
    });

    it('does not let a read ahead that failed late take away the one made after it', async () => {
        const test = await app();
        const save = test.runtime.bind('p', 'save', test.scope());
        const first = deferred();
        test.serve(() => first.promise);
        const failing = test.runtime.router.prefetch('/two');
        test.serve(() => acted('sa'));
        expect(await test.runtime.act(save, { json: {} })).toMatchObject({ ok: true });
        test.serve(() => page('two', 'read ahead after the write'));
        await test.runtime.router.prefetch('/two');
        first.reject(new TypeError('the network is gone'));
        await failing;
        const ahead = (test.runtime.router as unknown as { prefetched: Map<string, unknown> }).prefetched;
        expect([...ahead.keys()]).toEqual(['/two']);
        test.serve(() => page('two', 'asked for again'));
        expect(await test.runtime.router.navigate('/two')).toMatchObject({ status: 'committed' });
        expect(test.data()).toBe('read ahead after the write');
        expect(asked(test, '/two')).toBe(2);
    });
});
