// Releases as they are deployed: a second release built beside the first, the reload that serves
// it, a request under way across the reload, tabs of the earlier release, a rollback, builds that
// fail, and what a release's name is made of.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync, appendFileSync, cpSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';
import { build, cua, eventually, gate, serve, store, watch } from './lib/harness.mjs';
import { launch, mode, open, signIn, target } from './lib/target.mjs';

const only = mode === 'dev' ? 'a release is built; `php cua dev` has none (see dev.test.mjs)' : false;
let app;
let browser;
let first;
let second;
before(async () => {
    if (only) {
        return;
    }
    // In the background, as a deployment runs it: only such a server can be told to reload.
    app = await target('release', { own: true, workers: 2, daemon: true });
    browser = await launch();
    first = selected();
});
after(async () => {
    await browser?.close();
    await app?.stop();
});

const link = () => join(app.dir, 'build', 'psx', 'current');
const selected = () => basename(readlinkSync(link()));
const releases = () => readdirSync(join(app.dir, 'build', 'psx', 'releases')).sort();
const published = () =>
    readdirSync(join(app.dir, 'public'), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name).slice(app.dir.length + '/public'.length))
        .sort();
const edit = (file, from, to) => {
    const path = join(app.dir, file);
    const text = readFileSync(path, 'utf8');
    assert.ok(text.includes(from), `${file} has no "${from}"`);
    writeFileSync(path, text.replace(from, to));
    return () => writeFileSync(path, text);
};
function select(release) {
    const next = `${link()}.${process.pid}`;
    symlinkSync(`releases/${release}`, next);
    renameSync(next, link());
}
/**
 * Tells the server to reload. The process that served until now finishes the requests it has and
 * stops; with `drained`, waits until it has, so that what is sent next can only reach the new one.
 */
async function reload({ drained = true } = {}) {
    const result = await app.reload();
    assert.equal(result.code, 0, result.out);
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
    if (drained) {
        await eventually(`process ${old} of the earlier generation to stop`, gone, 30_000);
    }
    return { old, gone };
}
/** What a new document says it is of, and its markup. */
async function document(ctx, path = '/forms') {
    const answer = await ctx.request.get(path, { headers: { Accept: 'text/html' } });
    const html = await answer.text();
    const found = /<script type="application\/json" id="psx-bootstrap">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(found, `${path} is no document: ${answer.status()} ${html.slice(0, 200)}`);
    const envelope = JSON.parse(found[1]).envelope;
    return { build: envelope.build, envelope, html };
}
/** The answers a page's writes got, as they came over the wire. */
function answers(page) {
    const got = [];
    page.on('response', async response => {
        if (response.request().method() === 'POST') {
            let body = null;
            try {
                body = await response.json();
            } catch {
                // Not JSON.
            }
            got.push({ status: response.status(), body });
        }
    });
    return got;
}

test('a release that was built is served once the server is told to reload, and a request under way finishes where it began', { skip: only }, async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const forms = await open(ctx, '/forms');
    const home = await open(ctx);
    await signIn(home.page, 'una');
    const was = published();
    assert.equal((await document(ctx)).build, first);
    assert.equal(forms.page.url().endsWith('/forms'), true);

    edit('resources/pages/Forms.psx', "new Blank('Fill it in.')", "new Blank('Fill it in, in the later release.')");
    edit('resources/pages/Other.psx', 'Another page of', 'A later page of');
    second = await build(app.dir);
    assert.notEqual(second, first);
    assert.equal(selected(), second);
    assert.deepEqual(releases(), [first, second].sort());
    // The scripts of the earlier release lie beside the later one's.
    const now = published();
    assert.ok(was.every(file => now.includes(file)));
    assert.ok(now.length > was.length);

    // Built and selected is not served: the server reads what is selected once, as it starts.
    const still = await document(ctx);
    assert.equal(still.build, first);
    assert.match(still.html, /Fill it in\./);
    await forms.page.getByLabel('Title').fill('before the reload');
    await forms.page.getByRole('button', { name: 'Save', exact: true }).click();
    await forms.page.getByTestId('echoed').filter({ hasText: 'before the reload' }).waitFor();

    // A save under way when the reload comes: held in its action, in a worker of the earlier release.
    const held = gate(app.dir, 'home.save');
    held.hold();
    await home.page.getByTestId('draft').fill('saved across the reload');
    await home.page.getByTestId('save').click();
    await held.arrived();

    const { old, gone } = await reload({ drained: false });
    await eventually('the later release to be served', async () => (await document(ctx)).build === second, 30_000);
    assert.match((await document(ctx)).html, /Fill it in, in the later release\./);
    // Still held, while the later release already answers: the two overlap, and the process of
    // the earlier one stays for as long as the request it has.
    assert.equal(held.waiting(), 1);
    assert.equal(gone(), false);
    await held.open();
    await home.page.getByTestId('home-said').filter({ hasText: 'saved' }).waitFor();
    await eventually(`process ${old} to stop once its request is done`, gone, 30_000);
    assert.equal(store(app.dir).note('una').text, 'saved across the reload');
    assert.equal(store(app.dir).writes('note').filter(write => write.detail === 'saved across the reload').length, 1);
    assert.deepEqual(home.errors, []);
    await ctx.close();
});

test('a tab of the earlier release: its write is refused before it is entered, sent once, and its draft kept; its scripts are still there; its navigation becomes one new document', { skip: only }, async () => {
    // A tab that was opened on the earlier release is made here by serving it again for a moment.
    select(first);
    await reload();
    const ctx = await browser.newContext({ baseURL: app.url });
    await eventually('the earlier release to be served', async () => (await document(ctx)).build === first, 30_000);
    const forms = await open(ctx, '/forms');
    const long = await open(ctx, '/long');
    await long.page.evaluate(() => {
        window.sameDocument = true;
    });
    const earlier = published().filter(file => /\.js$/.test(file));
    select(second);
    await reload();
    await eventually('the later release to be served', async () => (await document(ctx)).build === second, 30_000);

    const got = answers(forms.page);
    const seen = watch(forms.page);
    const before = store(app.dir).writes('submit').length;
    await forms.page.getByLabel('Title').fill('typed in the old tab');
    await forms.page.getByRole('button', { name: 'Save', exact: true }).click();
    await forms.page.getByTestId('runs').filter({ hasText: '1' }).waitFor();
    await forms.page.waitForTimeout(500);
    // A failure the application is told of, known not to have been carried out: nothing is reloaded for it.
    assert.equal(await forms.page.getByTestId('problem').textContent(), 'build:rejected');
    assert.equal(got.length, 1);
    assert.equal(got[0].status, 409);
    assert.equal(got[0].body.problem.code, 'build_mismatch');
    assert.equal(got[0].body.execution, 'not-entered');
    assert.equal(got[0].body.respondingBuild, second);
    assert.equal(seen.posts().length, 1);
    assert.equal(store(app.dir).writes('submit').length, before);
    assert.equal(await forms.page.getByLabel('Title').inputValue(), 'typed in the old tab');
    // It is the same document still: nothing was reloaded under the person's draft.
    assert.equal(seen.all().filter(request => (request.headers.accept ?? '').includes('text/html')).length, 0);

    // Every script the earlier release published is still answered.
    for (const file of earlier) {
        assert.equal((await ctx.request.get(file)).status(), 200, file);
    }

    // A link in the old tab: the page is asked for as data of the earlier release, refused, and
    // asked for once more as a document, which is the later release's.
    const moved = watch(long.page);
    await long.page.getByRole('link', { name: 'Lazy', exact: true }).click();
    await long.page.getByTestId('clock').filter({ hasText: 'loaded in the browser at /lazy' }).waitFor();
    assert.equal(await long.page.evaluate(() => window.sameDocument === true), false);
    // Asked for once as data, refused, and once as a document: no more, so no loop.
    assert.deepEqual(
        moved.all().filter(request => request.url === '/lazy').map(request => ((request.headers.accept ?? '').includes('application/vnd.crab.psx+json') ? 'data' : 'document')),
        ['data', 'document'],
    );
    // It took the place a link takes: Back is the page the link was on.
    await long.page.goBack();
    await long.page.getByTestId('long-page').filter({ hasText: '1' }).waitFor();
    assert.deepEqual(long.errors, []);
    await ctx.close();
});

test('going back to the earlier release is selecting it and reloading; a tab of the later one is then the old one', { skip: only }, async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    assert.equal((await document(ctx)).build, second);
    const later = await open(ctx, '/forms');
    const got = answers(later.page);

    select(first);
    await reload();
    await eventually('the earlier release to be served', async () => (await document(ctx)).build === first, 30_000);
    const back = await document(ctx);
    assert.match(back.html, /Fill it in\./);
    assert.doesNotMatch(back.html, /later release/);
    if (mode === 'ssr') {
        // The renderer is of the release that is served, and there is the one.
        await eventually('the renderer of the earlier release alone', () => {
            const sockets = readdirSync(join(app.dir, 'storage', 'psx')).filter(name => name.endsWith('.sock'));
            return sockets.length === 1 && new RegExp(`^ssr-${first}\\.[1-9][0-9]*\\.sock$`).test(sockets[0]);
        });
        assert.match(back.html, /<main data-testid="forms">/);
    }
    const before = store(app.dir).writes('submit').length;
    await later.page.getByLabel('Title').fill('typed in the tab of the later release');
    await later.page.getByRole('button', { name: 'Save', exact: true }).click();
    await later.page.getByTestId('runs').filter({ hasText: '1' }).waitFor();
    assert.equal(await later.page.getByTestId('problem').textContent(), 'build:rejected');
    assert.equal(got[0].status, 409);
    assert.equal(got[0].body.execution, 'not-entered');
    assert.equal(got[0].body.respondingBuild, first);
    assert.equal(store(app.dir).writes('submit').length, before);
    // A new tab works on what is served.
    const fresh = await open(ctx, '/forms');
    await fresh.page.getByLabel('Title').fill('after the rollback');
    await fresh.page.getByRole('button', { name: 'Save', exact: true }).click();
    await fresh.page.getByTestId('echoed').filter({ hasText: 'after the rollback' }).waitFor();
    assert.deepEqual(fresh.errors, []);
    await ctx.close();
});

test('a build that fails selects nothing, publishes nothing, and leaves what is served as it was', { skip: only }, async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const serving = (await document(ctx)).build;
    const state = () => JSON.stringify({ selected: selected(), releases: releases(), published: published(), beside: readdirSync(join(app.dir, 'build', 'psx')).sort() });
    const was = state();
    const broken = {
        'TypeScript that does not check': ['resources/pages/Forms.psx', 'const idle: State =', "const wrong: number = 'not a number';\nconst idle: State ="],
        'PHP that does not parse': ['resources/pages/Home.psx', 'function load(', 'functio load('],
        'a page declared with a file that is not there': ['routes/pages.php', "'resources/pages/Lazy.psx'", "'resources/pages/Gone.psx'"],
        'a script that imports a file of the server’s': ['resources/pages/Lazy.psx', "import { clientOnly } from '@crabphp/psx';", "import { clientOnly } from '@crabphp/psx';\nimport settings from '../../.env?raw';\nconsole.log(settings);"],
        'a script that imports what does not exist': ['resources/pages/Lazy.psx', "import { clientOnly } from '@crabphp/psx';", "import { clientOnly } from '@crabphp/psx';\nimport { nothing } from './nowhere';\nconsole.log(nothing);"],
        'a loader that does not say what it returns': ['resources/pages/Lazy.psx', 'function load(): Shown', 'function load()'],
    };
    for (const [what, [file, from, to]] of Object.entries(broken)) {
        const restore = edit(file, from, to);
        try {
            const result = await cua(app.dir, ['psx:build']);
            assert.notEqual(result.code, 0, `${what} was built:\n${result.out.slice(-600)}`);
            // Said by the build once it has begun, or by the application that could not be defined.
            assert.match(result.out, /Nothing was selected|A server running in the background is not affected/, what);
            assert.equal(state(), was, what);
            // A reload now changes nothing: either it is refused, because the application as it
            // is written cannot be defined, and the server goes on as it was; or it is done, and
            // serves the release that was selected, whole and the same.
            const reloaded = await app.reload();
            if (reloaded.code !== 0) {
                assert.match(reloaded.out, /A server running in the background is not affected/, what);
            }
            assert.equal((await document(ctx)).build, serving, what);
            const { page, errors } = await open(ctx, '/lazy');
            await page.getByTestId('clock').waitFor();
            assert.deepEqual(errors, [], what);
            await page.close();
        } finally {
            restore();
        }
    }
    // Put right, it builds again, as the release it was.
    assert.equal(await build(app.dir), second);
    assert.equal(selected(), second);
    await ctx.close();
});

test('a release’s name is of the pages’ PHP, their scripts, the runtime they are bundled with and what the compiler makes of them', { skip: only }, async t => {
    const names = [selected()];
    const next = async (what, expectNew = true) => {
        const name = await build(app.dir);
        if (expectNew) {
            assert.ok(!names.includes(name), `${what} did not change the release's name`);
        }
        names.push(name);
        return name;
    };
    // Nothing changed: the same release, by the same name.
    assert.equal(await next('nothing', false), names[0]);

    edit('resources/pages/Other.psx', 'Other of {$account}', 'The other page of {$account}');
    await next('PHP of a page alone');

    edit('resources/pages/Other.psx', 'data-testid="other"', 'data-testid="other" data-edited="yes"');
    await next('TSX of a page alone');

    // The package's runtime, as an update of @crabphp/psx would change it.
    appendFileSync(join(app.dir, 'node_modules', '@crabphp', 'psx', 'dist', 'runtime.js'), '\nglobalThis.__psxAcceptance = (globalThis.__psxAcceptance ?? 0) + 1;\n');
    await next('the JavaScript runtime of the package');

    // The compiler, where it writes a page's PHP differently.
    edit('vendor/crabphp/psx/src/Compiler/Source.php', '"<?php declare(strict_types=1); namespace {$namespace};"', '"<?php declare(strict_types=1); /* compiled otherwise */ namespace {$namespace};"');
    await next('the compiler’s output');

    // What the name is not of, said plainly: PHP of the installed packages that changes nothing
    // the compiler writes. That is the installation's, deployed and rolled back with the
    // application's folder, not with the release.
    appendFileSync(join(app.dir, 'vendor', 'crabphp', 'psx', 'src', 'Runtime', 'Responder.php'), '\n// An edit that changes nothing a page is compiled to.\n');
    const same = await next('PHP of the package’s runtime alone', false);
    assert.equal(same, names.at(-2));
    t.diagnostic(`release names: ${names.join(' → ')}`);
});

test('a server does not start without a release, nor with one of another protocol', { skip: only }, async () => {
    await app.stop();
    const refused = async what => {
        await assert.rejects(serve(app.dir, { port: app.port, timeout: 20_000 }), error => {
            assert.match(error.message, what);
            return true;
        });
    };
    const kept = selected();
    renameSync(link(), `${link()}.kept`);
    await refused(/psx:build|no release/i);
    renameSync(`${link()}.kept`, link());

    const tampered = join(app.dir, 'build', 'psx', 'releases', 'tampered');
    cpSync(join(app.dir, 'build', 'psx', 'releases', kept), tampered, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(tampered, 'manifest.json'), 'utf8'));
    manifest.protocol = 2;
    writeFileSync(join(tampered, 'manifest.json'), JSON.stringify(manifest));
    select('tampered');
    await refused(/another protocol/);
    select(kept);
    rmSync(tampered, { recursive: true });
    // And with what it had, it starts.
    const again = await serve(app.dir, { port: app.port });
    assert.ok(existsSync(link()) && statSync(link()).isDirectory());
    await again.stop();
});
