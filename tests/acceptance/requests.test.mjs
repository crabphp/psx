// What a request that is wrong is answered, and what an upload leaves behind: the statuses the
// protocol names, a body too large, a form cut off part way, an upload abandoned, and the files the
// server wrote on the way.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { eventually, gate, pause, store, watch } from './lib/harness.mjs';
import { launch, open, target } from './lib/target.mjs';

let app;
let browser;
let temporary;
before(async () => {
    // Uploads on their way are kept in a folder of this application's own, so that what is left
    // there can be counted without looking at anybody else's files.
    app = await target('requests', { own: true, workers: 1, temporary: true });
    temporary = app.temporary;
    browser = await launch();
});
after(async () => {
    await browser?.close();
    await app?.stop();
});

const kept = () => (existsSync(join(app.dir, 'storage', 'uploads')) ? readdirSync(join(app.dir, 'storage', 'uploads')) : []);
const onTheirWay = () => readdirSync(temporary).filter(name => name.startsWith('php'));

/** The address and headers of the page's upload action, as the page itself sends them. */
async function action(ctx) {
    const { page } = await open(ctx, '/upload');
    const seen = watch(page);
    await page.getByLabel('File').setInputFiles({ name: 'small.txt', mimeType: 'text/plain', buffer: Buffer.from('small') });
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByTestId('upload-said').filter({ hasText: 'kept:5:' }).waitFor();
    const real = seen.posts()[0];
    const headers = Object.fromEntries(Object.entries(real.headers).filter(([name]) => name.startsWith('x-psx-') || name === 'accept'));
    return { page, url: real.url, headers, cookie: real.headers.cookie ?? '' };
}

/** Writes to the server by hand, as a client that misbehaves would, and reads what comes back. */
function raw(send, { half = false, wait = 4000 } = {}) {
    return new Promise((resolve, reject) => {
        const socket = connect(new URL(app.url).port, '127.0.0.1');
        let answer = '';
        const done = () => resolve({ answer, status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(answer)?.[1] ?? 0) });
        const timer = setTimeout(() => {
            socket.destroy();
            done();
        }, wait);
        socket.on('connect', () => {
            socket.write(send);
            if (half) {
                // Gone before the body it promised was sent.
                setTimeout(() => socket.destroy(), 300);
            }
        });
        socket.on('data', chunk => {
            answer += chunk.toString('latin1');
        });
        socket.on('close', () => {
            clearTimeout(timer);
            done();
        });
        socket.on('error', error => {
            clearTimeout(timer);
            if (answer === '' && !half) {
                reject(error);
            } else {
                done();
            }
        });
    });
}

function multipart(boundary, parts, { closed = true } = {}) {
    let body = '';
    for (const [name, value, filename] of parts) {
        body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"\r\nContent-Type: application/octet-stream` : ''}\r\n\r\n${value}\r\n`;
    }
    return body + (closed ? `--${boundary}--\r\n` : '');
}

function post(target, body, type, { length = Buffer.byteLength(body, 'latin1') } = {}) {
    const lines = [
        `POST ${target.url} HTTP/1.1`,
        `Host: 127.0.0.1:${new URL(app.url).port}`,
        `Origin: ${app.url}`,
        `Content-Type: ${type}`,
        `Content-Length: ${length}`,
        'Connection: close',
        ...Object.entries(target.headers).map(([name, value]) => `${name}: ${value}`),
    ];
    return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

test('an upload is kept once, whole, and nothing of it is left where uploads wait', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const { page, errors } = await open(ctx, '/upload');
    // Larger than the server holds in memory: it waits on disk until the action has read it.
    const content = randomBytes(100 * 1024);
    const before = kept().length;
    await page.getByLabel('File').setInputFiles({ name: 'photo.bin', mimeType: 'application/octet-stream', buffer: content });
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByTestId('upload-said').filter({ hasText: `kept:${content.length}:${createHash('sha256').update(content).digest('hex')}` }).waitFor();
    const files = kept();
    assert.equal(files.length, before + 1);
    const newest = files.map(name => join(app.dir, 'storage', 'uploads', name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    assert.ok(readFileSync(newest).equals(content));
    await eventually('nothing waits', () => onTheirWay().length === 0);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('a file over the action’s own limit is refused by the action; a body over the server’s is 413 and never reaches it', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const { page, errors } = await open(ctx, '/upload');
    const seen = watch(page);
    const [files, writes] = [kept().length, store(app.dir).count('upload')];

    // Within the server's limit, over the action's: the action says so, as a refusal it expected.
    await page.getByLabel('File').setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: randomBytes(160 * 1024) });
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByTestId('upload-said').filter({ hasText: 'refused:{"file":["is larger than 128 KiB"]}' }).waitFor();

    // Over the server's: refused before it is read, and told to the page as a failure that was not
    // carried out, sent once.
    seen.reset();
    await page.getByLabel('File').setInputFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: randomBytes(400 * 1024) });
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByTestId('upload-said').filter({ hasText: /^failed:/ }).waitFor();
    // The server's own answer is no PSX answer: the page cannot know from it what was done, and
    // says so. It is the application, never the client, that may decide to send it again.
    assert.equal(await page.getByTestId('upload-said').textContent(), 'failed:protocol:unknown:413');
    assert.equal(seen.posts().length, 1);
    assert.equal(kept().length, files);
    assert.equal(store(app.dir).count('upload'), writes);
    await eventually('nothing waits', () => onTheirWay().length === 0);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('a form cut off, one that is not a form, and one whose sender left are refused, and leave no file', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const target = await action(ctx);
    const [files, writes] = [kept().length, store(app.dir).count('upload')];
    const boundary = 'acceptance-boundary';
    const type = `multipart/form-data; boundary=${boundary}`;
    const file = 'x'.repeat(100 * 1024);

    // Whole and well made, by hand: the same answer the page got.
    const whole = await raw(post(target, multipart(boundary, [['label', 'by hand'], ['file', file, 'a.bin']]), type));
    assert.equal(whole.status, 200, whole.answer.slice(0, 300));

    const wrong = {
        'no closing boundary': [post(target, multipart(boundary, [['label', 'cut'], ['file', file, 'a.bin']], { closed: false }), type), [400]],
        'a boundary the body does not have': [post(target, multipart('another', [['file', file, 'a.bin']]), type), [400]],
        'no boundary named': [post(target, multipart(boundary, [['file', file, 'a.bin']]), 'multipart/form-data'), [400, 415]],
        'the same file field twice': [post(target, multipart(boundary, [['file', file, 'a.bin'], ['file', file, 'b.bin']]), type), [400]],
        'text where the file goes': [post(target, multipart(boundary, [['file', 'not a file']]), type), [422]],
        'no file at all': [post(target, multipart(boundary, [['label', 'nothing']]), type), [422]],
        'a kind of body the action does not take': [post(target, '<file/>', 'application/xml'), [415]],
        'JSON, which cannot carry a file': [post(target, '{"label":"json"}', 'application/json'), [415, 422]],
    };
    for (const [what, [request, statuses]] of Object.entries(wrong)) {
        const answer = await raw(request);
        assert.ok(statuses.includes(answer.status), `${what}: ${answer.status} ${answer.answer.slice(0, 200)}`);
        assert.doesNotMatch(answer.answer, /storage\/|\.php|#0 /, what);
    }

    // The sender leaves with half of what it said it would send.
    const body = multipart(boundary, [['label', 'half'], ['file', file, 'a.bin']]);
    await raw(post(target, body.slice(0, 80 * 1024), type, { length: Buffer.byteLength(body) }), { half: true });
    await pause(500);

    // One file and one write for the form that was whole; none for the others.
    assert.equal(kept().length, files + 1);
    assert.equal(store(app.dir).count('upload'), writes + 1);
    await eventually('nothing waits', () => onTheirWay().length === 0);
    // The worker is still the same one, and answers.
    assert.equal((await ctx.request.get('/up')).status(), 200);
    await ctx.close();
});

test('an upload the person abandons while the action runs is told as unknown, never sent again, and its file is not left waiting', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const { page } = await open(ctx, '/upload');
    const seen = watch(page);
    const held = gate(app.dir, 'upload.put');
    held.hold();
    await page.getByLabel('File').setInputFiles({ name: 'slow.bin', mimeType: 'application/octet-stream', buffer: randomBytes(100 * 1024) });
    await page.getByRole('button', { name: 'Send' }).click();
    await held.arrived();
    // The upload is whole at the server and waits for the action.
    assert.equal(onTheirWay().length, 1);
    // The person leaves the page: the request is abandoned by the browser.
    await page.goto('/forms');
    await held.open();
    await eventually('nothing waits', () => onTheirWay().length === 0);
    assert.equal(seen.posts().filter(request => request.url.includes('/_psx/a/')).length, 1);
    await ctx.close();
});

test('the statuses the protocol names are the ones answered', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const target = await action(ctx);
    const origin = { Origin: app.url };

    // 405: a query's address is read, an action's is written.
    assert.equal((await ctx.request.get(target.url, { headers: target.headers })).status(), 405);
    // 406: a page is asked for as something it cannot be.
    assert.equal((await ctx.request.get('/forms', { headers: { Accept: 'image/png' } })).status(), 406);
    // 400: JSON that is not JSON, to an action that takes JSON.
    const forms = await open(ctx, '/forms');
    const seen = watch(forms.page);
    await forms.page.getByLabel('Title').fill('real');
    await forms.page.getByLabel('Title').press('Enter');
    await forms.page.getByTestId('runs').filter({ hasText: '1' }).waitFor();
    const submit = seen.posts()[0];
    const headers = { ...Object.fromEntries(Object.entries(submit.headers).filter(([name]) => name.startsWith('x-psx-') || name === 'accept')), ...origin };
    const json = data => ctx.request.post(submit.url, { headers: { ...headers, 'Content-Type': 'application/json' }, data });
    assert.equal((await json('{"title": ')).status(), 400);
    assert.equal((await json('{"title":"a","title":"b"}')).status(), 400);
    assert.equal((await json('[]')).status(), 400);
    assert.equal((await json('{"title":7}')).status(), 422);
    assert.equal((await json('{"title":"fine"}')).status(), 200);
    // 415: a body of a kind the action does not take.
    assert.equal((await ctx.request.post(submit.url, { headers: { ...headers, 'Content-Type': 'text/plain' }, data: 'title=a' })).status(), 415);
    // 409: a release the server is not.
    const stale = await ctx.request.post(submit.url, { headers: { ...headers, 'x-psx-build': '0000000000000000', 'Content-Type': 'application/json' }, data: '{"title":"stale"}' });
    assert.equal(stale.status(), 409);
    assert.equal(store(app.dir).writes('submit').filter(write => write.detail === 'stale').length, 0);
    // 404: no such operation.
    assert.equal((await ctx.request.post(submit.url.replace(/[a-f0-9]{16}$/, 'ffffffffffffffff'), { headers: { ...headers, 'Content-Type': 'application/json' }, data: '{}' })).status(), 404);
    await ctx.close();
});
