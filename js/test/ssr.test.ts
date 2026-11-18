// @vitest-environment node
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listen, retire } from '../src/socket.js';
import { renderPage, watchParent } from '../src/ssr.js';
import { pageEnvelope } from '../src/testing.js';
import { manifest, posts } from './fixture.js';

const envelope = pageEnvelope(
    manifest,
    'b1',
    'posts.edit',
    '/posts/1',
    { id: '1' },
    { data: [{ name: 'Ada' }, posts['1']] },
);

function ask(socket: string, message: unknown, raw?: Buffer): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const body = raw ?? Buffer.from(JSON.stringify(message));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(body.length);
        const chunks: Buffer[] = [];
        const client = connect(socket);
        client.on('data', chunk => chunks.push(chunk));
        client.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).subarray(4).toString())));
        client.on('error', reject);
        client.write(Buffer.concat([head, body]));
    });
}

describe('rendering a page on the server', () => {
    it('renders the layout and the page from the envelope alone, and fetches nothing', async () => {
        const html = await renderPage(manifest, envelope);
        expect(html).toContain('<h1>Edit <!-- -->1</h1>');
        expect(html).toContain('Ada');
        // A query is not read while rendering: the browser reads it once the page is there.
        expect(html).toContain('pending');
    });

    it('keeps two renders apart', async () => {
        const other = pageEnvelope(
            manifest,
            'b1',
            'posts.edit',
            '/posts/2',
            { id: '2' },
            { data: [{ name: 'Grace' }, posts['2']] },
        );
        const [first, second] = await Promise.all([
            renderPage(manifest, envelope),
            renderPage(manifest, other),
        ]);
        expect(first).toContain('Ada');
        expect(first).not.toContain('Grace');
        expect(second).toContain('Grace');
        expect(second).not.toContain('Ada');
    });

    it('is given a page and nothing else', async () => {
        await expect(renderPage(manifest, { kind: 'problem' } as never)).rejects.toThrow();
    });

    it('gives the document’s nonce to the script React writes for a form, and to nothing a page wrote', async () => {
        const withForm = {
            ...manifest,
            modules: {
                ...manifest.modules,
                'pages/Home': async () => ({
                    default: () =>
                        createElement(
                            'main',
                            null,
                            createElement('form', { action: async () => undefined }, 'a form'),
                            createElement('p', null, '<script>window.text = 1</script>'),
                            createElement('div', {
                                dangerouslySetInnerHTML: { __html: '<script>window.raw = 1</script>' },
                            }),
                        ),
                }),
            },
        };
        const home = pageEnvelope(
            withForm,
            'b1',
            'home',
            '/',
            {},
            { data: [{ name: 'Ada' }, { greeting: 'Hello' }] },
        );

        const plain = await renderPage(withForm, home);
        const reacts = /<script>addEventListener\("submit"[\s\S]*?<\/script>/.exec(plain)?.[0];
        expect(reacts).toBeDefined();
        expect(plain).not.toContain('nonce=');

        const vouched = await renderPage(withForm, home, 'n0nce-Of_the+document/==');
        // React's own script, whole and unchanged, now runs under a policy that asks for the nonce.
        expect(vouched).toContain(
            `<script nonce="n0nce-Of_the+document/==">${reacts!.slice('<script>'.length)}`,
        );
        expect(vouched.split('nonce=').length).toBe(2);
        // Text stays text, and markup a page wrote itself is not spoken for.
        expect(vouched).toContain('&lt;script&gt;window.text = 1&lt;/script&gt;');
        expect(vouched).toContain('<script>window.raw = 1</script>');
        expect(vouched.replace(' nonce="n0nce-Of_the+document/=="', '')).toBe(plain);

        await expect(renderPage(withForm, home, '"><script>alert(1)</script>')).rejects.toThrow('nonce');
    });
});

describe('the renderer’s socket', () => {
    let server: Server | null = null;
    const logged: string[] = [];
    // Each test's own folder for its socket, removed after it.
    const folders: string[] = [];
    const start = (options: Partial<Parameters<typeof listen>[0]> = {}): Promise<string> => {
        const folder = mkdtempSync(join(tmpdir(), 'psx-ssr-'));
        folders.push(folder);
        const socket = join(folder, 'r.sock');
        server = listen({
            socket,
            build: 'b1',
            render: (page, nonce) => renderPage(manifest, page as never, nonce),
            log: line => logged.push(line),
            ...options,
        });
        return new Promise(resolve => server!.once('listening', () => resolve(socket)));
    };

    afterEach(async () => {
        const closing = server;
        server = null;
        logged.length = 0;
        if (closing !== null) {
            await new Promise<void>(resolve => closing.close(() => resolve()));
        }
        for (const folder of folders.splice(0)) {
            rmSync(folder, { recursive: true, force: true });
        }
    });

    it('is private to its account, answers a ping and renders a page', async () => {
        const socket = await start();
        expect(statSync(socket).mode & 0o777).toBe(0o600);
        expect(await ask(socket, { protocol: 1, build: 'b1', ping: true })).toEqual({ ok: true });
        const answer = await ask(socket, { protocol: 1, build: 'b1', envelope });
        expect(answer.ok).toBe(true);
        expect(answer.html).toContain('Edit');
    });

    it('refuses another release, another protocol and what is no JSON', async () => {
        const socket = await start();
        expect((await ask(socket, { protocol: 1, build: 'b2', envelope })).ok).toBe(false);
        expect((await ask(socket, { protocol: 2, build: 'b1', envelope })).ok).toBe(false);
        expect((await ask(socket, null, Buffer.from('{not json'))).ok).toBe(false);
    });

    it('refuses a request over its limit before reading it', async () => {
        const socket = await start({ maxRequestBytes: 64 });
        expect(await ask(socket, { protocol: 1, build: 'b1', envelope })).toEqual({
            ok: false,
            error: 'The request is larger than the renderer accepts.',
        });
    });

    it('says only that it failed, and logs the page without its data', async () => {
        const socket = await start({
            render: () => Promise.reject(new Error('secret detail of First')),
        });
        expect(await ask(socket, { protocol: 1, build: 'b1', envelope })).toEqual({
            ok: false,
            error: 'The page could not be rendered.',
        });
        expect(logged.join('\n')).toContain('route=posts.edit');
        expect(logged.join('\n')).not.toContain('"title"');
    });

    it('gives up on a render that takes too long, and refuses HTML over its limit', async () => {
        const slow = await start({ timeoutSeconds: 0.05, render: () => new Promise(() => undefined) });
        expect((await ask(slow, { protocol: 1, build: 'b1', envelope })).ok).toBe(false);
        server?.close();
        const large = await start({ maxHtmlBytes: 10 });
        expect((await ask(large, { protocol: 1, build: 'b1', envelope })).ok).toBe(false);
    });

    describe('a renderer told to stop serves those who stay connected until the last has gone', () => {
        /** Connects as a worker does: says it may still ask, and stays. */
        const hold = (
            socket: string,
            build = 'b1',
        ): Promise<{ answer: unknown; leave: () => Promise<void> }> =>
            new Promise((resolve, reject) => {
                const body = Buffer.from(JSON.stringify({ protocol: 1, build, hold: true }));
                const head = Buffer.alloc(4);
                head.writeUInt32BE(body.length);
                const client = connect(socket);
                client.on('error', reject);
                client.once('data', chunk =>
                    resolve({
                        answer: JSON.parse(chunk.subarray(4).toString()),
                        leave: () =>
                            new Promise(gone => {
                                client.once('close', () => gone());
                                client.destroy();
                            }),
                    }),
                );
                client.write(Buffer.concat([head, body]));
            });
        const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

        it('keeps a worker connected past the time an idle connection is given, and renders for it after being told to stop', async () => {
            const socket = await start({ timeoutSeconds: 0.05 });
            const [first, second] = [await hold(socket), await hold(socket)];
            expect(first.answer).toEqual({ ok: true });
            // Long past what a connection that asks nothing is otherwise given.
            await pause(150);
            let stopped = false;
            retire(server!, () => {
                stopped = true;
            });
            await pause(50);
            expect(stopped).toBe(false);
            expect((await ask(socket, { protocol: 1, build: 'b1', envelope })).ok).toBe(true);
            await first.leave();
            await pause(50);
            // One is still there: so is the renderer, for a connection made only now.
            expect(stopped).toBe(false);
            expect((await ask(socket, { protocol: 1, build: 'b1', envelope })).ok).toBe(true);
            await second.leave();
            await vi.waitFor(() => expect(stopped).toBe(true));
            await expect(ask(socket, { protocol: 1, build: 'b1', ping: true })).rejects.toThrow();
        });

        it('stops at once with nobody connected, finishing the render under way', async () => {
            let finish!: (html: string) => void;
            const socket = await start({
                render: () =>
                    new Promise(resolve => {
                        finish = resolve;
                    }),
            });
            const rendering = ask(socket, { protocol: 1, build: 'b1', envelope });
            await vi.waitFor(() => expect(finish).toBeDefined());
            let stopped = false;
            retire(server!, () => {
                stopped = true;
            });
            // Nobody new is let in, and the one being rendered for is answered.
            await expect(ask(socket, { protocol: 1, build: 'b1', ping: true })).rejects.toThrow();
            expect(stopped).toBe(false);
            finish('<p>done</p>');
            expect(await rendering).toEqual({ ok: true, html: '<p>done</p>' });
            await vi.waitFor(() => expect(stopped).toBe(true));
        });

        it('keeps nobody of another release', async () => {
            const socket = await start();
            const other = await hold(socket, 'b2');
            expect(other.answer).toEqual({ ok: false, error: 'This renderer is of another release.' });
            let stopped = false;
            retire(server!, () => {
                stopped = true;
            });
            await vi.waitFor(() => expect(stopped).toBe(true));
        });
    });

    describe('R1-B03: what runs and what waits are counted as they are', () => {
        /** Renders that end only when the test says so, with how many run at once written down. */
        const renders = () => {
            const open: { resolve: (html: string) => void; reject: (error: Error) => void }[] = [];
            const state = { active: 0, peak: 0, started: 0, open };
            const render = (): Promise<string> => {
                state.active++;
                state.started++;
                state.peak = Math.max(state.peak, state.active);
                return new Promise<string>((resolve, reject) => {
                    open.push({ resolve, reject });
                }).finally(() => {
                    state.active--;
                });
            };
            return { state, render };
        };
        const seen: { inflight: number; queued: number }[] = [];
        const observe = (state: { inflight: number; queued: number }): void => {
            seen.push({ ...state });
        };
        const page = { protocol: 1, build: 'b1', envelope };
        const until = async (what: () => boolean): Promise<void> => {
            // A wide margin: this waits for something that will happen, and times nothing.
            for (let turn = 0; turn < 2000 && !what(); turn++) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            expect(what()).toBe(true);
        };
        const last = (): { inflight: number; queued: number } => seen[seen.length - 1]!;

        afterEach(() => {
            seen.length = 0;
        });

        it('keeps a render’s place until the render has ended, however many give up waiting for it', async () => {
            const { state, render } = renders();
            const socket = await start({
                maxInflight: 1,
                maxQueue: 1,
                timeoutSeconds: 0.05,
                render,
                observe,
            });
            // Four, each after the one before was told its time ran out: the reviewer's case.
            for (let asked = 0; asked < 4; asked++) {
                expect(await ask(socket, page)).toEqual({
                    ok: false,
                    error: 'The page could not be rendered.',
                });
            }
            // One render ever started; the three after it waited their turn and were never run.
            expect(state.started).toBe(1);
            expect(state.peak).toBe(1);
            expect(state.active).toBe(1);
            expect(Math.max(...seen.map(entry => entry.inflight))).toBe(1);
            expect(Math.max(...seen.map(entry => entry.queued))).toBe(1);
            expect(last()).toEqual({ inflight: 1, queued: 0 });
            expect(logged.filter(line => line.includes('took too long'))).toHaveLength(1);
            expect(logged.filter(line => line.includes('waited too long'))).toHaveLength(3);

            // The render ends, late: nothing is sent for it, and the place is free again.
            state.open[0]!.resolve('<p>late</p>');
            await until(() => last().inflight === 0);
            const answer = ask(socket, page);
            await until(() => state.started === 2);
            state.open[1]!.resolve('<p>fresh</p>');
            expect(await answer).toEqual({ ok: true, html: '<p>fresh</p>' });
            expect(state.peak).toBe(1);
        });

        it('bounds what waits, and says it is busy past that', async () => {
            const { state, render } = renders();
            const socket = await start({ maxInflight: 2, maxQueue: 2, timeoutSeconds: 30, render, observe });
            const answers = [ask(socket, page), ask(socket, page), ask(socket, page), ask(socket, page)];
            await until(() => last()?.inflight === 2 && last().queued === 2);
            expect(await ask(socket, page)).toEqual({ ok: false, error: 'The renderer is busy.' });
            expect(await ask(socket, page)).toEqual({ ok: false, error: 'The renderer is busy.' });
            expect(state.started).toBe(2);

            // Each that ends lets one that waited run, and never more than two at once.
            state.open[0]!.resolve('<p>0</p>');
            await until(() => state.started === 3);
            state.open[1]!.reject(new Error('broke'));
            await until(() => state.started === 4);
            state.open[2]!.resolve('<p>2</p>');
            state.open[3]!.resolve('<p>3</p>');
            const settled = await Promise.all(answers);
            expect(settled.filter(answer => answer.ok === true)).toHaveLength(3);
            expect(settled.filter(answer => answer.ok === false)).toHaveLength(1);
            expect(state.peak).toBe(2);
            await until(() => last().inflight === 0 && last().queued === 0);
            expect(Math.max(...seen.map(entry => entry.queued))).toBe(2);
        });

        it('never runs what its asker stopped waiting for, and writes nothing to one who has gone', async () => {
            const { state, render } = renders();
            const socket = await start({ maxInflight: 1, maxQueue: 3, timeoutSeconds: 30, render, observe });
            const send = (): ReturnType<typeof connect> => {
                const body = Buffer.from(JSON.stringify(page));
                const head = Buffer.alloc(4);
                head.writeUInt32BE(body.length);
                const client = connect(socket);
                client.on('error', () => undefined);
                client.write(Buffer.concat([head, body]));
                return client;
            };
            const running = send();
            await until(() => last()?.inflight === 1);
            const waiting = [send(), send()];
            await until(() => last().queued === 2);
            const kept = ask(socket, page);
            await until(() => last().queued === 3);

            // Two that waited go away, and then the one whose render runs.
            waiting.forEach(client => client.destroy());
            await until(() => last().queued === 1);
            running.destroy();
            await until(() => last().queued === 1 && last().inflight === 1);
            // Its render still runs, and still holds the one place.
            expect(state.started).toBe(1);
            state.open[0]!.resolve('<p>for nobody</p>');
            await until(() => state.started === 2);
            // The one that stayed is the next to run: those that left were never started.
            state.open[1]!.resolve('<p>kept</p>');
            expect(await kept).toEqual({ ok: true, html: '<p>kept</p>' });
            expect(state.started).toBe(2);
            expect(state.peak).toBe(1);
            await until(() => last().inflight === 0 && last().queued === 0);
        });
    });
});

describe('a renderer whose server process is gone', () => {
    it('is told once its parent changes, and not before', () => {
        vi.useFakeTimers();
        try {
            let ppid = 4242;
            const gone = vi.fn();
            watchParent(gone, 4242, () => ppid, 1000);
            vi.advanceTimersByTime(5000);
            expect(gone).not.toHaveBeenCalled();
            // Killed outright: the system gives the renderer another parent.
            ppid = 1;
            vi.advanceTimersByTime(1000);
            expect(gone).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(5000);
            expect(gone).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('watches nothing when it has no parent of its own', () => {
        vi.useFakeTimers();
        try {
            const gone = vi.fn();
            watchParent(gone, 1, () => 999, 1000);
            vi.advanceTimersByTime(5000);
            expect(gone).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves the socket of the renderer started in its place', async () => {
        const folder = mkdtempSync(join(tmpdir(), 'psx-ssr-'));
        const socket = join(folder, 'r.sock');
        const options = {
            socket,
            build: 'b1',
            render: () => Promise.resolve('<p>x</p>'),
            log: () => undefined,
        };
        try {
            const old = listen(options);
            await new Promise(resolve => old.once('listening', resolve));
            // The server starts another renderer at the same address; it takes the path over.
            const fresh = listen(options);
            await new Promise(resolve => fresh.once('listening', resolve));
            const taken = lstatSync(socket).ino;
            await new Promise<void>(resolve => retire(old, resolve));
            expect(existsSync(socket)).toBe(true);
            expect(lstatSync(socket).ino).toBe(taken);
            expect(await ask(socket, { protocol: 1, build: 'b1', ping: true })).toEqual({ ok: true });
            // The one still at its own path removes its file when it stops, as before.
            await new Promise<void>(resolve => retire(fresh, resolve));
            expect(existsSync(socket)).toBe(false);
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    });
});
