import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestFailure } from '../src/protocol.js';
import { createTestApp, problem, redirect, type TestApp } from '../src/testing.js';
import { $savePost, $search, manifest, posts, seen } from './fixture.js';

let app: TestApp | null = null;

async function open(href = '/posts/1'): Promise<TestApp> {
    const id = href.split('/')[2];
    app = createTestApp({
        manifest,
        page:
            id === undefined
                ? { route: 'home', href, data: [{ name: 'Ada' }, { greeting: 'Hello' }] }
                : {
                      route: 'posts.edit',
                      href,
                      params: { id },
                      data: [{ name: 'Ada' }, posts[id]],
                      tags: [`post:${id}`],
                  },
    });
    app.transport
        .page('home', () => ({ data: [{ name: 'Ada' }, { greeting: 'Hello' }], head: { title: 'Home' } }))
        .page('posts.edit', (_url, params) =>
            posts[params.id!] === undefined
                ? problem(404, 'not_found', 'No such post.', { loaded: [{ name: 'Ada' }] })
                : {
                      data: [{ name: 'Ada' }, posts[params.id!]],
                      head: { title: `Edit ${params.id}` },
                      tags: [`post:${params.id}`],
                  },
        )
        .query('pages/Edit', 'history', (_input, params) => ({
            data: [`v1 of ${params.id}`],
            tags: [`post:${params.id}`],
        }))
        .action('pages/Edit', 'savePost', (input, params) => ({
            data: { id: Number(params.id), title: input.title, version: input.version + 1 },
            invalidate: [`post:${params.id}`],
        }));
    await app.ready;
    render(app.element);
    await screen.findByRole('heading');
    return app;
}

afterEach(() => {
    cleanup();
    app?.dispose();
    app = null;
    seen.layoutMounts = 0;
    posts['1'] = { id: 1, title: 'First', version: 1 };
});

const calls = (test: TestApp, part: string) =>
    test.transport.requests.filter(request => request.url.includes(part));

describe('navigation', () => {
    it('shows the page the document arrived with, the layout around it', async () => {
        await open();
        expect(screen.getByRole('heading').textContent).toBe('Edit 1');
        expect(screen.getByText(/Ada/)).toBeTruthy();
    });

    it('follows a link without leaving the document, and keeps the layout as it was', async () => {
        const test = await open();
        fireEvent.click(screen.getByText('count 0'));
        fireEvent.click(screen.getByText('Two'));
        await screen.findByRole('heading', { name: 'Edit 2' });
        expect(location.pathname).toBe('/posts/2');
        expect(document.title).toBe('Edit 2');
        expect(screen.getByText('count 1')).toBeTruthy();
        expect(seen.layoutMounts).toBe(1);
        expect(test.left).toEqual([]);
        const asked = calls(test, '/posts/2')[0]!;
        expect(asked.headers['x-psx-protocol']).toBe('1');
        expect(asked.headers['x-psx-build']).toBe('test-build');
        expect(asked.headers['x-psx-schema']).toBe('nav1');
    });

    it('gives another post another draft', async () => {
        await open();
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed on one' } });
        fireEvent.click(screen.getByText('Two'));
        await screen.findByRole('heading', { name: 'Edit 2' });
        expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Second');
    });

    it('leaves a link with a modifier, and one to another site, to the browser', async () => {
        const test = await open();
        fireEvent.click(screen.getByText('Two'), { ctrlKey: true });
        fireEvent.click(screen.getByText('Two'), { button: 1 });
        expect(calls(test, '/posts/2')).toEqual([]);
        expect(await test.router.navigate('https://elsewhere.example/x')).toEqual({
            status: 'document',
            href: 'https://elsewhere.example/x',
        });
        expect(test.left).toEqual(['https://elsewhere.example/x']);
    });

    it('lets the latest navigation win', async () => {
        const test = await open();
        let release: () => void = () => undefined;
        const slow = new Promise<void>(resolve => (release = resolve));
        test.transport.page('posts.edit', async (_url, params) => {
            if (params.id === '2') {
                await slow;
            }
            return {
                data: [{ name: 'Ada' }, posts[params.id!] ?? posts['1']],
                head: { title: `Edit ${params.id}` },
            };
        });
        const first = test.router.navigate('/posts/2');
        const second = test.router.navigate('/');
        expect(await second).toEqual({ status: 'committed', href: '/' });
        release();
        expect(await first).toEqual({ status: 'superseded' });
        await screen.findByText('Hello');
        expect(location.pathname).toBe('/');
    });

    it('does not move a page that is no longer the one on screen', async () => {
        const test = await open();
        const origin = seen.scope!.navigation!;
        await act(() => test.router.navigate('/posts/2'));
        expect(await test.router.navigate('/', { ifCurrent: origin })).toEqual({ status: 'superseded' });
        expect(location.pathname).toBe('/posts/2');
    });

    it('asks a blocker first, and goes only when it says so', async () => {
        const test = await open();
        const blocker = test.router.block(() => true);
        expect(await test.router.navigate('/')).toEqual({ status: 'blocked' });
        expect(blocker.getSnapshot()).toEqual({ href: '/', type: 'push' });
        expect(location.pathname).toBe('/posts/1');
        blocker.reset();
        expect(blocker.getSnapshot()).toBeNull();
        await test.router.navigate('/');
        let result: unknown;
        await act(async () => {
            result = await blocker.proceed();
        });
        expect(result).toEqual({ status: 'committed', href: '/' });
        expect(location.pathname).toBe('/');
        blocker.dispose();
    });

    it('shows a page’s own error for a loader’s refusal, inside the layout', async () => {
        await open();
        fireEvent.click(screen.getByText('One'));
        const test = app!;
        await act(() => test.router.navigate('/posts/9'));
        expect((await screen.findByRole('alert')).textContent).toBe('Edit refused: No such post.');
        expect(screen.getByText(/Ada/)).toBeTruthy();
    });

    it('keeps the page and says so when the network fails, and never guesses', async () => {
        const test = await open();
        test.transport.failNext();
        const result = await act(() => test.router.navigate('/posts/2'));
        expect(result.status).toBe('failed');
        expect(screen.getByRole('heading').textContent).toBe('Edit 1');
        expect(test.router.navigationError?.href).toBe('/posts/2');
    });

    it('leaves for the document when the server is of another release', async () => {
        const test = await open();
        test.transport.failNext(
            new Response(
                JSON.stringify({
                    protocol: 1,
                    kind: 'problem',
                    respondingBuild: 'newer',
                    requestedBuild: 'test-build',
                    execution: 'not-entered',
                    problem: {
                        status: 409,
                        code: 'build_mismatch',
                        message: 'Updated.',
                        fields: {},
                        query: {},
                        path: {},
                    },
                }),
                {
                    status: 409,
                    headers: {
                        'Content-Type': 'application/vnd.crab.psx+json',
                        'X-PSX-Protocol': '1',
                        'X-PSX-Build': 'newer',
                    },
                },
            ),
        );
        const result = await test.router.navigate('/posts/2');
        expect(result.status).toBe('document');
        expect(test.left).toEqual([`${location.origin}/posts/2`]);
    });

    it('follows a loader’s redirect', async () => {
        const test = await open();
        test.transport.page('home', () => redirect('/posts/2'));
        expect(await act(() => test.router.navigate('/'))).toEqual({ status: 'committed', href: '/posts/2' });
        await screen.findByRole('heading', { name: 'Edit 2' });
    });
});

describe('actions', () => {
    it('posts JSON to the scope’s address and gives the typed result', async () => {
        const test = await open();
        const result = await act(() => seen.save!({ title: 'Changed', version: 1 }));
        expect(result).toMatchObject({ ok: true, data: { id: 1, title: 'Changed', version: 2 } });
        const sent = calls(test, '/_psx/a/')[0]!;
        expect(sent.method).toBe('POST');
        expect(sent.url).toBe('/posts/1/_psx/a/aaaa');
        expect(sent.headers['content-type']).toBe('application/json');
        expect(sent.headers['x-psx-schema']).toBe('s-save');
        expect(sent.body).toEqual({ title: 'Changed', version: 1 });
    });

    it('sends a form as a form', async () => {
        const test = await open();
        const form = new FormData();
        form.set('title', 'From a form');
        form.set('version', '1');
        test.transport.action('pages/Edit', 'savePost', input => ({
            data: { id: 1, title: String((input as FormData).get('title')), version: 2 },
        }));
        const result = await act(() => seen.save!.form(form));
        expect(result).toMatchObject({ ok: true, data: { title: 'From a form' } });
        const sent = calls(test, '/_psx/a/')[0]!;
        expect(sent.body).toBeInstanceOf(FormData);
        expect(sent.headers['content-type']).toBeUndefined();
    });

    it('gives an expected failure as a result, not an exception', async () => {
        const test = await open();
        test.transport.action('pages/Edit', 'savePost', () =>
            problem(422, 'validation', 'Check the fields.', { fields: { title: ['is too short'] } }),
        );
        const result = await seen.save!({ title: '', version: 1 });
        expect(result).toEqual({
            ok: false,
            problem: expect.objectContaining({ status: 422, fields: { title: ['is too short'] } }),
        });
    });

    it('never takes a proxy’s page or a login page for an answer', async () => {
        const test = await open();
        // A gateway's own error page: the action may have run.
        test.transport.failNext(
            new Response('<html>Bad gateway</html>', {
                status: 502,
                headers: { 'Content-Type': 'text/html' },
            }),
        );
        const gateway = await seen.save!({ title: 'x', version: 1 }).catch((error: unknown) => error);
        expect(gateway).toBeInstanceOf(RequestFailure);
        expect((gateway as RequestFailure).outcome).toBe('unknown');
        // A 200 that is a login page, as a redirect followed by mistake gives.
        test.transport.failNext(
            new Response('<html>Log in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
        );
        const login = await seen.save!({ title: 'x', version: 1 }).catch((error: unknown) => error);
        expect(login).toBeInstanceOf(RequestFailure);
        // JSON of the right shape that is not the protocol's is no answer either.
        test.transport.failNext(
            new Response(JSON.stringify({ ok: true, data: { id: 1, title: 'x', version: 9 } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        await expect(seen.save!({ title: 'x', version: 1 })).rejects.toBeInstanceOf(RequestFailure);
        expect(calls(test, '/_psx/a/')).toHaveLength(3);
    });

    it('says the outcome is unknown when the answer is lost, and sends nothing twice', async () => {
        const test = await open();
        test.transport.failNext();
        const failure = await seen.save!({ title: 'Lost', version: 1 }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(RequestFailure);
        expect((failure as RequestFailure).outcome).toBe('unknown');
        expect(calls(test, '/_psx/a/')).toHaveLength(1);
    });

    it('refuses an answer that is not what the action declares', async () => {
        const test = await open();
        test.transport.action('pages/Edit', 'savePost', () => ({
            data: { id: 1, title: 'x', version: 2, secret: 'leaked' },
        }));
        await expect(seen.save!({ title: 'x', version: 1 })).rejects.toThrow(/could not send/);
    });

    it('loads what an action says is stale, without touching the draft', async () => {
        const test = await open();
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My draft' } });
        posts['1'] = { id: 1, title: 'Saved by action', version: 2 };
        await act(() => seen.save!({ title: 'Saved by action', version: 1 }));
        await waitFor(() => expect(screen.getByTestId('version').textContent).toBe('2'));
        expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('My draft');
        expect(calls(test, '/_psx/q/bbbb').length).toBeGreaterThanOrEqual(2);
    });

    it('keeps a scope frozen, and saves the post it was made on from wherever it is called', async () => {
        const test = await open();
        const save = seen.save!;
        const scope = seen.scope!;
        expect(Object.isFrozen(scope)).toBe(true);
        expect(() => {
            (scope as { href: string }).href = '/posts/2';
        }).toThrow();
        await act(() => test.router.navigate('/posts/2'));
        await screen.findByRole('heading', { name: 'Edit 2' });
        await act(() => save({ title: 'Late, for one', version: 1 }));
        expect(calls(test, '/_psx/a/').map(request => request.url)).toEqual(['/posts/1/_psx/a/aaaa']);
        expect(location.pathname).toBe('/posts/2');
    });

    it('refuses a scope it did not make', async () => {
        await open();
        const forged = { ...seen.scope!, params: { id: '2' } };
        expect(() => $savePost.at(forged as never)).toThrow(/not a scope PSX made/);
    });
});

describe('queries', () => {
    it('reads once for every component that asks the same thing', async () => {
        const test = await open();
        await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('v1 of 1'));
        expect(screen.getByTestId('history-again').textContent).toBe('1');
        const asked = calls(test, '/_psx/q/bbbb');
        expect(asked).toHaveLength(1);
        expect(asked[0]!.method).toBe('GET');
        expect(asked[0]!.url).toBe('/posts/1/_psx/q/bbbb?limit=2');
    });

    it('reads under StrictMode, whose effects subscribe, leave and subscribe again (R1-C06)', async () => {
        app = createTestApp({
            manifest,
            page: {
                route: 'posts.edit',
                href: '/posts/1',
                params: { id: '1' },
                data: [{ name: 'Ada' }, posts['1']],
            },
        });
        const cancelled: string[] = [];
        const inner = app.transport.handle;
        app.transport.query('pages/Edit', 'history', (_input, params) => [`v1 of ${params.id}`]);
        // A transport that says a request was cancelled only a turn after it was.
        const runtime = (app.element.props as { runtime: { transport: unknown } }).runtime;
        Object.defineProperty(runtime, 'transport', {
            value: (url: string, init: RequestInit) =>
                new Promise<Response>((resolve, reject) => {
                    init.signal?.addEventListener('abort', () => {
                        cancelled.push(url);
                        setTimeout(() => reject(new DOMException('cancelled', 'AbortError')), 0);
                    });
                    setTimeout(() => inner(url, { ...init, signal: undefined }).then(resolve, reject), 5);
                }),
        });
        await app.ready;
        render(<StrictMode>{app.element}</StrictMode>);
        await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('v1 of 1'));
        expect(screen.getByTestId('history-again').textContent).toBe('1');
        // The churn of the effects cancelled nothing: both readers share the one request.
        expect(cancelled).toEqual([]);
        expect(calls(app, '/_psx/q/bbbb')).toHaveLength(1);
    });

    it('calls a service mounted once without a scope', async () => {
        const test = await open();
        test.transport.query('components/People', 'search', input => [`${input.get('words')} Lovelace`]);
        expect(await $search({ words: 'Ada' })).toEqual(['Ada Lovelace']);
        expect(calls(test, '/people/')[0]!.url).toBe('/people/_psx/q/cccc?words=Ada');
    });

    it('throws a query’s refusal as a problem', async () => {
        const test = await open();
        test.transport.query('components/People', 'search', () => problem(403, 'forbidden', 'Not yours.'));
        await expect($search({ words: 'Ada' })).rejects.toMatchObject({ problem: { status: 403 } });
    });

    it('holds a fixture to the declared shape', async () => {
        const test = await open();
        test.transport.query('components/People', 'search', () => [1, 2]);
        await expect($search({ words: 'Ada' })).rejects.toThrow(/could not send/);
    });

    it('drops what it held when who is signed in changes', async () => {
        const test = await open();
        await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('v1 of 1'));
        const before = calls(test, '/_psx/q/bbbb').length;
        const state = await act(() => test.authChanged());
        expect(state.status).toBe('reconciled');
        await waitFor(() => expect(calls(test, '/_psx/q/bbbb').length).toBeGreaterThan(before));
    });
});
