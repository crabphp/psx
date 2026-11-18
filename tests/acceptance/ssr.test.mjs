// Rendering on the server: the renderer's socket is private and of this release, the browser takes
// over the server's markup rather than making it again, a worker renders so many pages at once and
// refuses the rest in so many words, and a renderer that dies is started again.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';
import { cua, eventually, gate, pause, work } from './lib/harness.mjs';
import { alive, launch, mode, open, signIn, target } from './lib/target.mjs';

const only = mode === 'ssr' ? false : 'only a release rendered on the server has a renderer';
let app;
let browser;
before(async () => {
    if (only) {
        return;
    }
    app = await target('ssr', { own: true, workers: 1 });
    browser = await launch();
});
after(async () => {
    await browser?.close();
    await app?.stop();
});

const release = () => basename(readlinkSync(join(app.dir, 'build', 'psx', 'current')));
/** The sockets in an application's folder for them: each named by its release and the server process it is of. */
const sockets = (dir = app.dir) => readdirSync(join(dir, 'storage', 'psx')).filter(name => name.endsWith('.sock'));
const socket = () => {
    const [name, ...more] = sockets();
    assert.match(name ?? '', new RegExp(`^ssr-${release()}\\.[1-9][0-9]*\\.sock$`));
    assert.deepEqual(more, []);
    return join(app.dir, 'storage', 'psx', name);
};

function ask(message) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(message));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(body.length);
        const chunks = [];
        const client = connect(socket());
        client.on('data', chunk => chunks.push(chunk));
        client.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).subarray(4).toString())));
        client.on('error', reject);
        client.write(Buffer.concat([head, body]));
    });
}

/** The renderer this application's own server started: found among that server's children only. */
function renderer() {
    const found = [];
    const walk = parent => {
        let lines;
        try {
            lines = execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(parent)], { encoding: 'utf8' }).split('\n');
        } catch {
            // It has no children.
            return;
        }
        for (const line of lines) {
            const [, pid, args] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
            if (pid === undefined) {
                continue;
            }
            if (args.includes('ssr/server.mjs') && args.includes(`--socket=${socket()}`)) {
                found.push(Number(pid));
            }
            walk(pid);
        }
    };
    walk(app.pid);
    return found;
}

test('the renderer listens where only the application’s own account reaches, as the release that is served', { skip: only }, async () => {
    const folder = join(app.dir, 'storage', 'psx');
    // One socket: of this release, and of the server process that runs the renderer.
    const owner = Number(/\.(\d+)\.sock$/.exec(socket())[1]);
    assert.equal(execFileSync('ps', ['-o', 'args=', '-p', String(owner)], { encoding: 'utf8' }).includes('cua start'), true);
    const [at, around] = [statSync(socket()), statSync(folder)];
    assert.ok(at.isSocket());
    assert.equal(at.mode & 0o777, 0o600);
    assert.equal(around.mode & 0o777, 0o700);
    assert.equal(at.uid, process.getuid());
    assert.ok(!socket().startsWith(join(app.dir, 'public')));
    // One renderer, of this release, with the limits the application is configured with.
    assert.equal(renderer().length, 1);
    assert.deepEqual(await ask({ protocol: 1, build: release(), ping: true }), { ok: true });
    const other = await ask({ protocol: 1, build: '0000000000000000', ping: true });
    assert.equal(other.ok, false);
    assert.match(other.error, /another release/);
    assert.equal((await ask({ protocol: 2, build: release(), ping: true })).ok, false);
    // Nothing of it is answered over HTTP.
    const ctx = await browser.newContext({ baseURL: app.url });
    for (const address of [`/storage/psx/${basename(socket())}`, '/build/psx/current/ssr/server.mjs', '/ssr/server.mjs']) {
        assert.ok((await ctx.request.get(address)).status() >= 400, address);
    }
    await ctx.close();
});

test('the browser takes over the markup the server made, without making it again and without a complaint', { skip: only }, async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const signed = await open(ctx);
    await signIn(signed.page, 'olga');

    const { page, errors } = await open(ctx);
    const complaints = [];
    page.on('console', message => {
        if (message.type() === 'error' || /hydrat/i.test(message.text())) {
            complaints.push(message.text());
        }
    });
    // The application's scripts are held: what is on screen first is the server's alone.
    let letScripts;
    const scripts = new Promise(resolve => {
        letScripts = resolve;
    });
    await page.route(
        url => url.pathname.endsWith('.js'),
        async route => {
            await scripts;
            await route.continue();
        },
    );
    await page.goto('/', { waitUntil: 'commit' });
    await page.getByTestId('home-account').filter({ hasText: 'olga' }).waitFor();
    assert.equal(await page.title(), 'Home of olga');
    assert.equal(await page.getByTestId('secret').textContent(), 'secret of olga');
    await page.evaluate(() => {
        document.querySelector('[data-testid="home-account"]').servers = true;
        document.querySelector('[data-testid="shell-clicks"]').servers = true;
    });
    // Not yet alive: a click does nothing.
    await page.getByTestId('shell-clicks').click();
    assert.equal(await page.getByTestId('shell-clicks').textContent(), '0');

    letScripts();
    await eventually('the page to come alive', async () => {
        await page.getByTestId('shell-clicks').click();
        return Number(await page.getByTestId('shell-clicks').textContent()) > 0;
    });
    // The very elements the server wrote, now the application's.
    assert.deepEqual(
        await page.evaluate(() => [document.querySelector('[data-testid="home-account"]').servers, document.querySelector('[data-testid="shell-clicks"]').servers]),
        [true, true],
    );
    await page.getByTestId('mine').filter({ hasText: 'olga: private of olga' }).waitFor();
    assert.deepEqual(complaints, []);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('past what a worker renders at once a document is refused in so many words, never answered as someone else, and the next is served', { skip: only }, async t => {
    const people = [];
    for (const account of ['pia', 'quin']) {
        const ctx = await browser.newContext({ baseURL: app.url });
        const { page } = await open(ctx);
        await signIn(page, account);
        people.push({ ctx, account });
    }
    const burst = [];
    for (let index = 0; index < 30; index++) {
        for (const who of people) {
            burst.push(who.ctx.request.get('/', { headers: { Accept: 'text/html' } }).then(async answer => ({ who, answer, text: await answer.text() })));
        }
    }
    let served = 0;
    let refused = 0;
    for (const { who, answer, text } of await Promise.all(burst)) {
        const other = who === people[0] ? people[1].account : people[0].account;
        assert.doesNotMatch(text, new RegExp(`\\b${other}\\b`));
        if (answer.status() === 200) {
            served++;
            assert.match(text, new RegExp(`data-testid="home-account"[^>]*>${who.account}<`));
        } else {
            refused++;
            assert.equal(answer.status(), 503);
            assert.equal(answer.headers()['retry-after'], '1');
            assert.doesNotMatch(text, new RegExp(`\\b${who.account}\\b|secret|private`));
        }
    }
    // Sixteen at once is the worker's limit, as configured; sixty were asked of one worker together.
    assert.ok(served >= 16, `served ${served}`);
    assert.ok(refused > 0, 'nothing was refused: the limit was not reached');
    t.diagnostic(`of 60 documents asked at once of one worker, ${served} were rendered and ${refused} answered 503 with Retry-After`);
    // And it is over at once.
    for (const who of people) {
        const answer = await who.ctx.request.get('/', { headers: { Accept: 'text/html' } });
        assert.equal(answer.status(), 200);
        assert.match(await answer.text(), new RegExp(`data-testid="home-account"[^>]*>${who.account}<`));
        await who.ctx.close();
    }
});

test('a renderer that dies is an error while it is gone, never a page rendered another way, and is started again', { skip: only }, async t => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const { page } = await open(ctx);
    await signIn(page, 'rita');
    const [first] = renderer();
    assert.ok(first);
    // This application's own renderer, by its process id: nothing else is signalled.
    process.kill(first, 'SIGKILL');
    const started = Date.now();
    let down = 0;
    await eventually(
        'a new renderer to answer',
        async () => {
            const answer = await ctx.request.get('/', { headers: { Accept: 'text/html' } });
            const text = await answer.text();
            if (answer.status() === 200) {
                assert.match(text, /data-testid="home-account"[^>]*>rita</);
                return true;
            }
            down++;
            assert.equal(answer.status(), 503);
            assert.doesNotMatch(text, /rita|secret|psx-bootstrap/);
            return false;
        },
        30_000,
    );
    const [second] = renderer();
    assert.ok(second && second !== first);
    t.diagnostic(`the renderer answered again ${Date.now() - started} ms after it was killed; ${down} document(s) were answered 503 meanwhile`);
    // The page in the browser went on meanwhile: a navigation is data, and asks nothing of a renderer.
    await page.getByRole('link', { name: 'Other', exact: true }).click();
    await page.getByTestId('other').waitFor();
    await ctx.close();
});

test('a server that has just started or been reloaded renders its first document, and still does once the earlier one is gone', { skip: only }, async t => {
    // In the background, as a deployment runs it: only such a server can be told to reload.
    const own = await target('ssr-reload', { own: true, workers: 2, daemon: true });
    const statuses = {};
    const ask = async () => {
        const answer = await fetch(`${own.url}/forms`, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(10_000) });
        const text = await answer.text();
        const said = answer.status === 200 && text.includes('id="psx-bootstrap"') ? '200' : `${answer.status} ${text.slice(0, 60)}`;
        statuses[said] = (statuses[said] ?? 0) + 1;
        return said;
    };
    const folder = join(own.dir, 'storage', 'psx');
    const built = basename(readlinkSync(join(own.dir, 'build', 'psx', 'current')));
    // What a server that was killed would have left: a socket nobody listens at, named as this
    // application names them, of a process that is no more. And one that is not this application's.
    const leaver = spawn(process.execPath, [
        '-e',
        `const { createServer } = require('node:net');
         const names = ['ssr-${built}.' + process.pid + '.sock', 'other.' + process.pid + '.sock'];
         let listening = 0;
         for (const name of names) {
             createServer().listen(require('node:path').join(${JSON.stringify(folder)}, name), () => {
                 if (++listening === names.length) process.stdout.write(names.join(' ') + '\\n');
             });
         }`,
    ]);
    const left = await new Promise(done => leaver.stdout.once('data', data => done(String(data).trim().split(' '))));
    leaver.kill('SIGKILL');
    await new Promise(done => leaver.once('exit', done));
    assert.deepEqual(left.filter(name => sockets(own.dir).includes(name)), left);
    try {
        assert.equal(await ask(), '200');
        // The same release each time: what a deployment that changed only PHP, or a setting, reloads.
        for (let round = 0; round < 3; round++) {
            // A document under way when the server is reloaded: its loader is held, so that it is
            // the earlier server that still has to render it, after it was told to stop.
            const slow = gate(own.dir, 'fragile.load.a');
            slow.hold();
            const under = fetch(`${own.url}/fragile?mode=a`, { headers: { Accept: 'text/html' } });
            await slow.arrived();
            const result = await own.reload();
            assert.equal(result.code, 0, result.out);
            assert.equal(await ask(), '200', `round ${round}`);
            await slow.open();
            const finished = await under;
            assert.equal(finished.status, 200, `round ${round}: the document under way`);
            assert.match(await finished.text(), /<main data-testid="fragile">mode (<!-- -->)?a/);
            // The first document after the reload was said to be done.
            assert.equal(await ask(), '200', `round ${round}`);
            const old = Number(/took over from process (\d+)/.exec(result.out)?.[1]);
            assert.ok(old > 0, result.out);
            const gone = () => {
                try {
                    process.kill(old, 0);
                    return false;
                } catch {
                    return true;
                }
            };
            // While the earlier one finishes and stops, and for a while after it has.
            const until = Date.now() + 30_000;
            while (!gone() && Date.now() < until) {
                await ask();
                await pause(40);
            }
            assert.equal(gone(), true, `process ${old} of the earlier generation stopped`);
            for (let after = 0; after < 25; after++) {
                await ask();
                await pause(40);
            }
            assert.deepEqual(Object.keys(statuses), ['200'], `round ${round}: ${JSON.stringify(statuses)}`);
            // One renderer's socket again: the earlier server took its own with it. What the killed
            // one left was taken away when the next server started, and what is not this
            // application's was left alone.
            const now = sockets(own.dir);
            assert.equal(now.filter(name => name.startsWith('ssr-')).length, 1, now.join(' '));
            assert.equal(now.includes(left[0]), false);
            assert.equal(now.includes(left[1]), true);
        }
        t.diagnostic(`across three reloads of one release every document was rendered: ${JSON.stringify(statuses)}`);
    } finally {
        await own.stop();
    }
});

test('a server whose renderer does not listen in time is not ready: it does not start, and it does not take the place of one that works', { skip: only }, async t => {
    const own = await target('ssr-unready', { own: true, workers: 2, daemon: true });
    const statuses = {};
    const ask = async () => {
        let said;
        try {
            const answer = await fetch(`${own.url}/forms`, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(10_000) });
            const text = await answer.text();
            said = answer.status === 200 && text.includes('id="psx-bootstrap"') ? '200' : `${answer.status} ${text.slice(0, 60)}`;
        } catch (error) {
            said = `no answer: ${error.cause?.code ?? error.name}`;
        }
        statuses[said] = (statuses[said] ?? 0) + 1;
        return said;
    };
    /** Asks for documents, one after another, for as long as something takes. */
    const during = async doing => {
        let going = true;
        const asking = (async () => {
            while (going) {
                await ask();
                await pause(50);
            }
        })();
        try {
            return await doing();
        } finally {
            going = false;
            await asking;
        }
    };
    // In the place of Node: what never listens, and what does after eight seconds, longer than a
    // worker waits for it.
    const never = join(own.dir, 'never-node');
    const late = join(own.dir, 'late-node');
    writeFileSync(never, '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 });
    writeFileSync(late, `#!/bin/sh\nsleep 8\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    const settings = readFileSync(join(own.dir, '.env'), 'utf8');
    const runs = node => writeFileSync(join(own.dir, '.env'), node === null ? settings : `${settings}PSX_SSR_NODE=${node}\n`);
    const master = () => Number(/^ssr-[0-9a-f]+\.([1-9][0-9]*)\.sock$/.exec(sockets(own.dir).find(name => name.startsWith('ssr-')) ?? '')?.[1]);
    const timed = async doing => {
        const from = Date.now();
        return [await doing(), (Date.now() - from) / 1000];
    };
    let running = true;
    try {
        assert.equal(await ask(), '200');
        const first = master();
        assert.ok(first > 0);

        // A reload to a renderer that never listens: it fails, and the server that worked goes on.
        runs(never);
        const [failed, failedAfter] = await during(() => timed(() => own.reload()));
        assert.notEqual(failed.code, 0, failed.out);
        assert.match(failed.out, /did not accept connections within/);
        assert.ok(failedAfter >= 15, `the reload gave up after ${failedAfter} seconds`);
        assert.equal(await ask(), '200');
        assert.deepEqual(Object.keys(statuses), ['200'], JSON.stringify(statuses));
        assert.equal(master(), first, 'the renderer of the server that worked is the one that listens');
        // Why, where the person who runs it reads it.
        const logs = readdirSync(join(own.dir, 'storage', 'logs')).map(name => readFileSync(join(own.dir, 'storage', 'logs', name), 'utf8')).join('\n');
        assert.match(logs, /the renderer did not listen within 5 seconds/);
        t.diagnostic(`a reload to a renderer that never listens failed after ${failedAfter.toFixed(1)} s; every document meanwhile: ${JSON.stringify(statuses)}`);

        // A reload to one that listens late, after a worker gave up waiting once: it is done when
        // the renderer is there and not before, and nothing is refused on the way.
        runs(late);
        const [slow, slowAfter] = await during(() => timed(() => own.reload()));
        assert.equal(slow.code, 0, slow.out);
        assert.ok(slowAfter >= 8, `the reload was done after ${slowAfter} seconds, before its renderer listened`);
        assert.equal(await ask(), '200');
        await eventually('the earlier server to have gone', () => {
            try {
                process.kill(first, 0);
                return false;
            } catch {
                return true;
            }
        }, 40_000);
        for (let after = 0; after < 20; after++) {
            await ask();
            await pause(40);
        }
        assert.deepEqual(Object.keys(statuses), ['200'], JSON.stringify(statuses));
        assert.notEqual(master(), first);
        t.diagnostic(`a reload to a renderer that listens after 8 s was done after ${slowAfter.toFixed(1)} s; every document meanwhile: ${JSON.stringify(statuses)}`);

        // Started, not reloaded: with a renderer that never listens it does not start at all.
        await own.stop();
        running = false;
        runs(never);
        const [refused, refusedAfter] = await timed(() => cua(own.dir, ['start', '--daemon'], own.env));
        assert.notEqual(refused.code, 0, refused.out);
        assert.match(refused.out, /did not accept connections within/);
        assert.match(await ask(), /^no answer/);
        assert.deepEqual(sockets(own.dir).filter(name => name.startsWith('ssr-')), []);
        t.diagnostic(`a start with a renderer that never listens failed after ${refusedAfter.toFixed(1)} s, and left nothing listening`);

        // And with one that listens late it starts late, and renders its first document.
        runs(late);
        const [started, startedAfter] = await timed(() => cua(own.dir, ['start', '--daemon'], own.env));
        assert.equal(started.code, 0, started.out);
        running = true;
        assert.ok(startedAfter >= 8, `the server said it had started after ${startedAfter} seconds, before its renderer listened`);
        assert.equal(await ask(), '200');
        t.diagnostic(`a start with a renderer that listens after 8 s was done after ${startedAfter.toFixed(1)} s, and its first document was rendered`);
    } finally {
        runs(null);
        if (running) {
            const stopped = await cua(own.dir, ['stop'], own.env);
            assert.equal(stopped.code, 0, stopped.out);
        }
    }
});

test('a renderer that stays down: pages are refused and the rest is answered; a worker lost meanwhile is not replaced and the server stops; with the renderer back it is started and renders', { skip: only }, async t => {
    // In the place of Node: Node, unless a file says the renderer is down, and then what never listens.
    const down = join(work, 'renderer-down');
    const node = join(work, 'flaky-node');
    writeFileSync(node, `#!/bin/sh\nif [ -e ${JSON.stringify(down)} ]; then exec sleep 600; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    rmSync(down, { force: true });
    const own = await target('ssr-outage', { own: true, workers: 2, daemon: true, settings: { PSX_SSR_NODE: node } });
    const get = async (path, accept) => {
        try {
            const answer = await fetch(`${own.url}${path}`, { headers: { Accept: accept }, signal: AbortSignal.timeout(10_000) });
            const text = await answer.text();
            return answer.status === 200 ? '200' : `${answer.status} ${text.slice(0, 40)}`;
        } catch (error) {
            return `no answer: ${error.cause?.code ?? error.name}`;
        }
    };
    const page = () => get('/forms', 'text/html');
    const other = () => get('/up', '*/*');
    /** The server's own account of its workers: `php cua status`. */
    const workers = async () => {
        const said = (await cua(own.dir, ['status'], own.env)).out;
        const of = name => Number(new RegExp(`${name}\\s+(\\d+)`).exec(said)?.[1] ?? 0);
        return { said, keeper: Number(/pid (\d+)/.exec(said)?.[1] ?? 0), renderer: of('psx-ssr #0'), http: [of('http #0'), of('http #1')] };
    };
    /** Ends what the renderer's worker runs: the server starts it again, as whatever the file says. */
    const end = async signal => {
        const { renderer } = await workers();
        process.kill(Number(execFileSync('pgrep', ['-P', String(renderer)], { encoding: 'utf8' }).trim().split('\n')[0]), signal);
    };
    let running = true;
    try {
        assert.equal(await page(), '200');
        const before = await workers();
        assert.ok(before.keeper > 0 && before.http.every(pid => pid > 0), before.said);

        // The renderer goes, and what the server starts in its place does not listen.
        writeFileSync(down, '');
        await end('SIGKILL');
        await eventually('a page to be refused', async () => (await page()).startsWith('503'));
        await pause(3000);
        assert.match(await page(), /^503/);
        assert.equal(await other(), '200', 'what is not a page is answered all the while');
        const during = await workers();
        assert.deepEqual([during.keeper, during.http], [before.keeper, before.http], 'the workers that ran go on running');

        // Put right while the server still runs: what stands in the renderer's place is ended, the
        // server starts the renderer, and pages are rendered again. Nothing was restarted by hand.
        rmSync(down);
        const from = Date.now();
        await end('SIGTERM');
        await eventually('a page to be rendered again', async () => (await page()) === '200', 30_000);
        const back = (Date.now() - from) / 1000;
        const after = await workers();
        assert.deepEqual([after.keeper, after.http], [before.keeper, before.http]);
        t.diagnostic(`renderer down with every worker running: pages 503, the rest 200; put right, pages were rendered again after ${back.toFixed(1)} s with no restart`);

        // Down again, and this time a worker is lost: one cannot be started without the renderer.
        writeFileSync(down, '');
        await end('SIGKILL');
        await eventually('a page to be refused', async () => (await page()).startsWith('503'));
        const lost = Date.now();
        process.kill(after.http[0], 'SIGKILL');
        const seen = { page: {}, other: {} };
        let stopped = null;
        while (stopped === null && Date.now() - lost < 120_000) {
            const [a, b] = [await page(), await other()];
            seen.page[a.slice(0, 3)] = (seen.page[a.slice(0, 3)] ?? 0) + 1;
            seen.other[b.slice(0, 3)] = (seen.other[b.slice(0, 3)] ?? 0) + 1;
            if (/No server is running/.test((await workers()).said)) {
                stopped = (Date.now() - lost) / 1000;
            }
            await pause(500);
        }
        assert.notEqual(stopped, null, 'the server stopped');
        running = false;
        // While it ran, the worker that was left answered: never a page rendered another way.
        assert.ok(seen.other['200'] > 0, JSON.stringify(seen));
        assert.equal(seen.page['200'], undefined, JSON.stringify(seen));
        assert.match(await other(), /^no answer/);
        const log = readFileSync(join(own.dir, 'storage', 'logs', 'server.log'), 'utf8');
        assert.match(log, /the renderer did not listen within 5 seconds/);
        assert.match(log, /exceeded five restarts in sixty seconds/);
        t.diagnostic(`renderer down and a worker lost: the server had stopped after ${stopped.toFixed(1)} s; meanwhile pages ${JSON.stringify(seen.page)}, the rest ${JSON.stringify(seen.other)}`);

        // Put right after it stopped: the renderer is there again, and the server is started.
        rmSync(down);
        const started = await cua(own.dir, ['start', '--daemon'], own.env);
        assert.equal(started.code, 0, started.out);
        running = true;
        assert.equal(await page(), '200');
        assert.equal(await other(), '200');
    } finally {
        rmSync(down, { force: true });
        if (running) {
            const stopping = await cua(own.dir, ['stop'], own.env);
            assert.equal(stopping.code, 0, stopping.out);
        }
    }
});

test('READY-C03: a navigation begun before the page started, still on its way or failed, leaves the server’s markup to be taken over without a complaint', { skip: only }, async () => {
    for (const ending of ['arrives', 'fails']) {
        const ctx = await browser.newContext({ baseURL: app.url });
        const { page, errors } = await open(ctx);
        // The code of the document's own page is held: the application has started, the page has not.
        let wanted = 0;
        let letCode;
        const code = new Promise(resolve => {
            letCode = resolve;
        });
        await page.route(
            url => /\/Fragile\.psx/.test(url.pathname),
            async route => {
                wanted++;
                await code;
                await route.continue();
            },
        );
        // And so is the answer to the navigation begun meanwhile.
        let letAnswer;
        const answer = new Promise(resolve => {
            letAnswer = resolve;
        });
        const to = ending === 'arrives' ? '/fragile?mode=a' : '/fragile?mode=throw';
        await page.route(
            url => url.pathname + url.search === to,
            async route => {
                await answer;
                await route.continue();
            },
        );
        await page.goto('/fragile?mode=b', { waitUntil: 'commit' });
        await eventually('the page’s code to be asked for', () => wanted > 0);
        await page.waitForFunction(() => window.psx !== undefined);
        // What the server wrote, marked so that it is known again.
        await page.evaluate(to => {
            window.written = document.querySelector('[data-testid="fragile"]');
            window.result = null;
            window.psx.router.navigate(to).then(result => {
                window.result = result.status;
            });
        }, to);
        assert.equal(await page.evaluate(() => window.written?.textContent.startsWith('mode b')), true);
        if (ending === 'fails') {
            letAnswer();
            await page.waitForFunction(() => window.result === 'failed');
        }
        // The page's code arrives: the markup is taken over as it is, and only then is the rest said.
        letCode();
        await alive(page);
        if (ending === 'arrives') {
            await page.getByTestId('page-pending').waitFor();
        } else {
            await page.locator('[data-psx-navigation-error]').waitFor();
        }
        assert.equal(await page.evaluate(() => document.querySelector('[data-testid="fragile"]') === window.written), true);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => location.pathname + location.search), '/fragile?mode=b');
        // And what follows is as ever.
        if (ending === 'arrives') {
            letAnswer();
            await page.getByTestId('fragile').filter({ hasText: 'mode a' }).waitFor();
            assert.equal(await page.evaluate(() => window.result), 'committed');
        } else {
            await page.locator('[data-psx-navigation-error]').getByRole('button', { name: 'Dismiss' }).click();
            await page.getByRole('link', { name: 'Fragile a', exact: true }).click();
            await page.getByTestId('fragile').filter({ hasText: 'mode a' }).waitFor();
        }
        assert.deepEqual(errors, []);
        await ctx.close();
    }
});
