// Two people at once, in one long-running worker: requests held at gates so that they overlap in an
// order the test chose, and each answer, title and cache checked to be its own person's.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { eventually, gate, store, watch } from './lib/harness.mjs';
import { launch, mode, open, shown, signIn, target } from './lib/target.mjs';

let app;
let browser;
before(async () => {
    // One worker: both people's requests are in the same process, taking turns.
    app = await target('isolation', { own: true, workers: 1 });
    browser = await launch();
});
after(async () => {
    await browser?.close();
    await app?.stop();
});

async function person(account) {
    const ctx = await browser.newContext({ baseURL: app.url });
    const { page, errors } = await open(ctx);
    await signIn(page, account);
    return { ctx, page, errors, account };
}

const same = pids => new Set(pids).size === 1;

test('two people’s documents made at the same time in one worker each hold their own data, title and nothing of the other', async () => {
    const [ann, ben] = [await person('ann'), await person('ben')];
    const held = gate(app.dir, 'home.load');
    held.hold();
    const asked = [ann.ctx.request.get('/', { headers: { Accept: 'text/html' } }), ben.ctx.request.get('/', { headers: { Accept: 'text/html' } })];
    const pids = await held.arrived(2);
    assert.ok(same(pids), `the two requests waited in different processes: ${pids}`);
    await held.open();
    const [first, second] = await Promise.all(asked.map(async answer => (await answer).text()));
    for (const [html, own, other] of [
        [first, 'ann', 'ben'],
        [second, 'ben', 'ann'],
    ]) {
        assert.match(html, new RegExp(`<title>Home of ${own}</title>`));
        assert.match(html, new RegExp(`secret of ${own}`));
        assert.doesNotMatch(html, new RegExp(other));
        if (mode === 'ssr') {
            // Rendered by the one renderer both share, not only carried as data.
            assert.match(html, new RegExp(`data-testid="home-account"[^>]*>${own}<`));
        }
    }
    await ann.ctx.close();
    await ben.ctx.close();
});

test('answers that finish in the other order than they were asked still go to who asked', async () => {
    const [cat, dan] = [await person('cat'), await person('dan')];
    const [first, second] = [gate(app.dir, 'home.load.cat'), gate(app.dir, 'home.load.dan')];
    first.hold();
    second.hold();
    // cat asks first, dan second; dan is answered first.
    const early = cat.page.reload();
    await first.arrived();
    const late = dan.page.reload();
    await second.arrived();
    await second.open();
    await late;
    await dan.page.getByTestId('home-account').filter({ hasText: 'dan' }).waitFor();
    assert.equal(first.waiting(), 1);
    await first.open();
    await early;
    await cat.page.getByTestId('home-account').filter({ hasText: 'cat' }).waitFor();
    for (const [who, other] of [
        [cat, 'dan'],
        [dan, 'cat'],
    ]) {
        await who.page.getByTestId('mine').filter({ hasText: `${who.account}: private of ${who.account}` }).waitFor();
        assert.equal(await who.page.title(), `Home of ${who.account}`);
        assert.doesNotMatch(await shown(who.page), new RegExp(other));
        assert.deepEqual(who.errors, []);
    }
    await cat.ctx.close();
    await dan.ctx.close();
});

test('two people’s navigations, queries and saves overlap in one worker and stay their own in the page and in the store', async () => {
    const [eve, fay] = [await person('eve'), await person('fay')];

    // Navigations inside the application, held together.
    for (const who of [eve, fay]) {
        await who.page.getByRole('link', { name: 'Other', exact: true }).click();
        await who.page.getByTestId('other').waitFor();
    }
    const loads = gate(app.dir, 'home.load');
    const queries = gate(app.dir, 'home.query');
    loads.hold();
    queries.hold();
    for (const who of [eve, fay]) {
        await who.page.getByRole('link', { name: 'Home', exact: true }).click();
    }
    assert.ok(same(await loads.arrived(2)));
    await loads.open();
    assert.ok(same(await queries.arrived(2)));
    await queries.open();
    for (const [who, other] of [
        [eve, 'fay'],
        [fay, 'eve'],
    ]) {
        await who.page.getByTestId('mine').filter({ hasText: `${who.account}: private of ${who.account}` }).waitFor();
        assert.equal(await who.page.title(), `Home of ${who.account}`);
        assert.doesNotMatch(await shown(who.page), new RegExp(other));
    }

    // Saves, held together and let go together.
    const saves = gate(app.dir, 'home.save');
    saves.hold();
    for (const who of [eve, fay]) {
        await who.page.getByTestId('draft').fill(`a note only ${who.account} wrote`);
        await who.page.getByTestId('save').click();
    }
    assert.ok(same(await saves.arrived(2)));
    await saves.open();
    for (const [who, other] of [
        [eve, 'fay'],
        [fay, 'eve'],
    ]) {
        await who.page.getByTestId('home-said').filter({ hasText: 'saved' }).waitFor();
        // The save says its page's data is stale: the page reads its own note again.
        await who.page.getByTestId('note').filter({ hasText: `a note only ${who.account} wrote` }).waitFor();
        assert.equal(store(app.dir).note(who.account).text, `a note only ${who.account} wrote`);
        assert.doesNotMatch(await shown(who.page), new RegExp(other));
        assert.deepEqual(who.errors, []);
    }
    await eve.ctx.close();
    await fay.ctx.close();
});

/** The data a document arrived with, as the application reads it; a document without it fails. */
function bootstrap(html) {
    const found = /<script type="application\/json" id="psx-bootstrap">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(found, 'the document carries no psx-bootstrap');
    return JSON.parse(found[1]);
}

/** What a page's own navigation to an address is sent with: the release, the schema, who it knows. */
async function asked(who, name, path) {
    const seen = watch(who.page);
    await who.page.getByRole('link', { name, exact: true }).click();
    await eventually(`the navigation to ${path}`, () => seen.all().some(request => request.url === path));
    const sent = seen.all().find(request => request.url === path);
    return Object.fromEntries(Object.entries(sent.headers).filter(([header]) => header.startsWith('x-psx-') || header === 'accept'));
}

test('forty documents and protocol navigations asked at once for two people are each answered as who asked', async () => {
    const [gus, hal] = [await person('gus'), await person('hal')];
    const paths = { '/': 'home', '/other': 'other' };
    for (const who of [gus, hal]) {
        // The headers the built client itself sends for each address, taken from its own requests.
        who.headers = { '/other': await asked(who, 'Other', '/other') };
        await who.page.getByTestId('other').waitFor();
        who.headers['/'] = await asked(who, 'Home', '/');
        await who.page.getByTestId('home-account').waitFor();
        for (const sent of Object.values(who.headers)) {
            assert.equal(sent.accept, 'application/vnd.crab.psx+json');
            assert.match(sent['x-psx-build'], /^[a-f0-9]{16}$/);
            assert.ok(sent['x-psx-schema']);
        }
    }
    const build = gus.headers['/']['x-psx-build'];

    // Sixteen documents and twenty-four navigations. A worker renders sixteen pages at once on the
    // server and no more ("psx.ssr.max_inflight"); what it does past that is ssr.test.mjs's to show.
    const burst = [];
    for (let index = 0; index < 12; index++) {
        for (const who of [gus, hal]) {
            const path = index % 2 === 0 ? '/' : '/other';
            if (index < 8) {
                burst.push(who.ctx.request.get(path, { headers: { Accept: 'text/html' } }).then(async answer => ({ who, path, kind: 'document', answer, text: await answer.text() })));
            }
            burst.push(who.ctx.request.get(path, { headers: who.headers[path] }).then(async answer => ({ who, path, kind: 'navigation', answer, text: await answer.text() })));
        }
    }
    const answers = await Promise.all(burst);
    assert.equal(answers.length, 40);
    for (const { who, path, kind, answer, text } of answers) {
        const other = who === gus ? 'hal' : 'gus';
        const what = `${kind} ${path} for ${who.account}`;
        assert.equal(answer.status(), 200, what);
        let envelope;
        if (kind === 'document') {
            assert.match(answer.headers()['content-type'], /^text\/html/, what);
            envelope = bootstrap(text).envelope;
        } else {
            assert.match(answer.headers()['content-type'], /^application\/vnd\.crab\.psx\+json/, what);
            envelope = JSON.parse(text);
        }
        // The page asked for, of this release, with the layout's and the page's data of who asked.
        assert.equal(envelope.protocol, 1, what);
        assert.equal(envelope.kind, 'page', what);
        assert.equal(envelope.build, build, what);
        assert.deepEqual(envelope.route, { id: paths[path], href: path }, what);
        assert.deepEqual(envelope.nodes[0].data, { account: who.account, secret: `secret of ${who.account}` }, what);
        assert.equal(envelope.nodes[1].data.account, who.account, what);
        assert.equal(envelope.head.title, `${path === '/' ? 'Home' : 'Other'} of ${who.account}`, what);
        // The same person and the same revision each time: what the page holds its answers to.
        who.auth ??= envelope.auth;
        assert.ok(envelope.auth, what);
        assert.deepEqual(envelope.auth, who.auth, what);
        assert.doesNotMatch(text, new RegExp(`\\b${other}\\b`), what);
    }
    assert.notDeepEqual(gus.auth, hal.auth);
    await gus.ctx.close();
    await hal.ctx.close();
});
