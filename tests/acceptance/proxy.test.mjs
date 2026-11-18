// Something between the browser and the application that answers in its place: an error page, a
// redirect, a page that says all is well, an answer cut off, an answer lost after the write was
// done. None of it may look like success, and no write may be sent a second time.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { after, before, test } from 'node:test';
import { port, store, watch } from './lib/harness.mjs';
import { launch, open, target } from './lib/target.mjs';

let app;
let browser;
let proxy;
let url;
/** What the proxy does with the next write it is handed; everything else passes through. */
let meddle = null;
const handed = [];

before(async () => {
    app = await target('proxy', { own: true });
    browser = await launch();
    const upstream = new URL(app.url);
    proxy = createServer((incoming, outgoing) => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => {
            const body = Buffer.concat(chunks);
            const write = incoming.method === 'POST';
            if (write) {
                handed.push(`${incoming.method} ${incoming.url}`);
            }
            const how = write ? meddle : null;
            if (how?.instead) {
                // Answered here; the application never hears of it.
                outgoing.writeHead(how.instead.status, how.instead.headers);
                outgoing.end(how.instead.body ?? '');
                return;
            }
            const forwarded = request(
                { host: upstream.hostname, port: upstream.port, path: incoming.url, method: incoming.method, headers: incoming.headers },
                answer => {
                    const parts = [];
                    answer.on('data', part => parts.push(part));
                    answer.on('end', () => {
                        const whole = Buffer.concat(parts);
                        if (how?.after === 'lose') {
                            // The application did the work; its answer never arrives.
                            outgoing.destroy();
                        } else if (how?.after === 'cut') {
                            // The headers and half of the body arrive; then the line goes dead.
                            outgoing.writeHead(answer.statusCode, { ...answer.headers, 'content-length': String(whole.length) });
                            outgoing.write(whole.subarray(0, Math.floor(whole.length / 2)), () => outgoing.destroy());
                        } else if (how?.after === 'replace') {
                            outgoing.writeHead(how.status, how.headers);
                            outgoing.end(how.body);
                        } else {
                            outgoing.writeHead(answer.statusCode, answer.headers);
                            outgoing.end(whole);
                        }
                    });
                },
            );
            forwarded.on('error', () => outgoing.destroy());
            forwarded.end(body);
        });
    });
    const at = port() + 40;
    await new Promise(listening => proxy.listen(at, '127.0.0.1', listening));
    url = `http://127.0.0.1:${at}`;
});
after(async () => {
    await browser?.close();
    await new Promise(closed => proxy?.close(closed) ?? closed());
    proxy?.closeAllConnections?.();
    await app?.stop();
});

async function submit(how, title) {
    const ctx = await browser.newContext({ baseURL: url });
    const { page, errors } = await open(ctx, '/forms');
    const seen = watch(page);
    const before = store(app.dir).writes('submit').length;
    handed.length = 0;
    meddle = how;
    try {
        await page.getByLabel('Title').fill(title);
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.getByTestId('runs').filter({ hasText: '1' }).waitFor();
        // Time for anything that would send it again on its own.
        await page.waitForTimeout(700);
    } finally {
        meddle = null;
    }
    const result = {
        echoed: await page.getByTestId('echoed').textContent(),
        problem: await page.getByTestId('problem').textContent(),
        posts: seen.posts().map(sent => sent.url.replace(/[a-f0-9]{16}$/, '*')),
        handed: handed.map(sent => sent.replace(/[a-f0-9]{16}$/, '*')),
        written: store(app.dir).writes('submit').slice(before).map(write => write.detail),
        draft: await page.getByLabel('Title').inputValue(),
        errors,
    };
    await ctx.close();
    return result;
}

const once = ['/forms/_psx/a/*'];

test('through a proxy that only passes things on, the application works as it does without one', async () => {
    const result = await submit(null, 'passed on');
    assert.equal(JSON.parse(result.echoed).title, 'passed on');
    assert.deepEqual(result.posts, once);
    assert.deepEqual(result.written, ['passed on']);
    assert.deepEqual(result.errors, []);
});

for (const [what, instead, problem] of [
    ['an error page of the proxy’s own', { status: 502, headers: { 'Content-Type': 'text/html' }, body: '<h1>Bad Gateway</h1>' }, 'server:unknown'],
    ['a page that says all is well', { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>Welcome to the hotel network</html>' }, 'protocol:unknown'],
    ['JSON that is not the protocol’s', { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":true,"data":{"title":"forged"}}' }, 'protocol:unknown'],
    ['a redirect to a sign-in page', { status: 302, headers: { Location: '/login' } }, 'network:unknown'],
    ['a redirect that would carry the write elsewhere', { status: 307, headers: { Location: '/plain' } }, 'network:unknown'],
    ['nothing: too many requests', { status: 429, headers: { 'Retry-After': '1', 'Content-Type': 'text/plain' }, body: 'slow down' }, 'protocol:unknown'],
]) {
    test(`${what}, in place of the application’s answer, is a failure of unknown outcome and the write is sent once`, async () => {
        const result = await submit({ instead }, `never arrives: ${what}`);
        assert.equal(result.echoed, '');
        assert.equal(result.problem, problem);
        // Once from the page, once to the proxy, and nowhere else: not to where a redirect pointed.
        assert.deepEqual(result.posts, once);
        assert.deepEqual(result.handed, ['POST /forms/_psx/a/*']);
        assert.deepEqual(result.written, []);
        assert.equal(result.draft, `never arrives: ${what}`);
        assert.deepEqual(result.errors, []);
    });
}

for (const [what, how, problem] of [
    ['is cut off part way', { after: 'cut' }, /^(network|protocol):unknown$/],
    ['is replaced by an error page', { after: 'replace', status: 504, headers: { 'Content-Type': 'text/html' }, body: '<h1>Gateway Timeout</h1>' }, /^server:unknown$/],
]) {
    test(`a write the application did, whose answer ${what}, is an unknown outcome and is not sent again`, async () => {
        const title = `done, but the answer ${what}`;
        const result = await submit(how, title);
        assert.equal(result.echoed, '');
        assert.match(result.problem, problem);
        assert.deepEqual(result.posts, once);
        assert.deepEqual(result.handed, ['POST /forms/_psx/a/*']);
        // Done exactly once.
        assert.deepEqual(result.written, [title]);
        assert.deepEqual(result.errors, []);
    });
}

test('a connection that dies before any answer: the page sends its write once and calls the outcome unknown; what the browser’s own transport does is measured, not promised', async t => {
    const title = 'done, but the connection died';
    const result = await submit({ after: 'lose' }, title);
    assert.equal(result.echoed, '');
    assert.equal(result.problem, 'network:unknown');
    // The application's code asked once, and was told once that it cannot know.
    assert.deepEqual(result.posts, once);
    // Below the page, a browser may send a request again on a new connection when a connection it
    // had used before dies without a byte of answer: HTTP lets it, and no page can see or stop it.
    // PSX promises no exactly-once execution; a write that must not happen twice carries a key of
    // the application's own. How often this browser did it is written down with the result.
    assert.ok(result.handed.length >= 1);
    assert.ok(result.written.length >= 1 && result.written.every(written => written === title));
    assert.equal(result.written.length, result.handed.length);
    t.diagnostic(`browser transport delivered the write ${result.handed.length} time(s); the page sent it once`);
    assert.deepEqual(result.errors, []);
});
