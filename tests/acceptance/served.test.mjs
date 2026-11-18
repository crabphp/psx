// What the application gives a browser, and what it does not: a Content-Security-Policy that is
// really enforced and that every page runs under without a violation, and no file of the server's,
// however it is asked for.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch, mode, open, signIn, target } from './lib/target.mjs';

let app;
let browser;
before(async () => {
    app = await target('served');
    browser = await launch();
});
after(async () => {
    await browser?.close();
    await app?.stop();
});

const built = mode !== 'dev';
// Text that only the server's half of the fixture holds: its PHP, its settings, its store.
const servers = /<\?php|secret of \{|private of \{|final readonly class|namespace Acceptance|APP_DEBUG|storage_path\(|SQLite format 3|Acceptance\\\\?Store/;

async function violations(context) {
    await context.addInitScript(() => {
        window.violations = [];
        document.addEventListener('securitypolicyviolation', event => {
            window.violations.push(`${event.violatedDirective} ${event.blockedURI}`);
        });
    });
}

test('every page runs under the policy without a violation, and what the policy forbids is really stopped', { skip: built ? false : 'the policy is for a built release; under `php cua dev` Vite’s client needs more, and the fixture sends none' }, async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    await violations(ctx);
    const { page, errors } = await open(ctx);
    const refused = [];
    page.on('console', message => {
        if (/Content Security Policy|Refused to/.test(message.text())) {
            refused.push(message.text());
        }
    });

    await signIn(page, 'nora');
    for (const name of ['Other', 'Acme', 'Acme members', 'Globex', 'Home']) {
        await page.getByRole('link', { name, exact: true }).click();
        await page.waitForLoadState('networkidle');
    }
    await page.getByTestId('draft').fill('under the policy');
    await page.getByTestId('save').click();
    await page.getByTestId('home-said').filter({ hasText: 'saved' }).waitFor();
    for (const [path, shown] of [
        ['/boxes', 'box-left-count'],
        ['/forms', 'forms'],
        ['/upload', 'upload'],
        ['/lazy', 'clock'],
        ['/long', 'long'],
        ['/fragile?mode=missing', 'route-error'],
    ]) {
        await page.goto(path);
        await page.getByTestId(shown).waitFor();
    }
    assert.deepEqual(await page.evaluate(() => window.violations), []);
    assert.deepEqual(refused, []);
    assert.deepEqual(errors, []);

    // The policy is the browser's to enforce, and it does: a script without the nonce does not run,
    // text is not evaluated as code, and a handler written into markup is not called.
    const stopped = await page.evaluate(async () => {
        const script = document.createElement('script');
        script.textContent = 'window.inlineRan = true';
        document.head.append(script);
        // In a task of the page's own: what the test itself evaluates is let through by the browser.
        const evaluated = await new Promise(done =>
            setTimeout(() => {
                try {
                    // eslint-disable-next-line no-eval
                    done(eval('true'));
                } catch {
                    done(false);
                }
            }, 0),
        );
        const holder = document.createElement('div');
        holder.innerHTML = '<img src="/missing.png" onerror="window.handlerRan = true">';
        document.body.append(holder);
        await new Promise(done => setTimeout(done, 300));
        return { inline: window.inlineRan === true, evaluated, handler: window.handlerRan === true, seen: window.violations.length };
    });
    assert.deepEqual({ inline: stopped.inline, evaluated: stopped.evaluated, handler: stopped.handler }, { inline: false, evaluated: false, handler: false });
    assert.ok(stopped.seen >= 2);
    await ctx.close();
});

test('a nonce is the document’s own, on every script it runs, and never the same twice', { skip: built ? false : 'no policy under `php cua dev`' }, async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const nonces = new Set();
    for (const path of ['/forms', '/forms', '/login', '/long?page=2', '/fragile?mode=missing']) {
        const answer = await ctx.request.get(path, { headers: { Accept: 'text/html' } });
        const policy = answer.headers()['content-security-policy'];
        assert.ok(policy, `${path} has no policy`);
        assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|\*/);
        const nonce = /'nonce-([A-Za-z0-9_-]{20,})'/.exec(policy)?.[1];
        assert.ok(nonce, policy);
        const html = await answer.text();
        const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(found => found[1]);
        assert.ok(scripts.length >= 2);
        for (const attributes of scripts) {
            if (/type="application\/json"/.test(attributes)) {
                // Data, which no browser runs.
                continue;
            }
            assert.match(attributes, new RegExp(`nonce="${nonce}"`), `${path}: <script${attributes}>`);
        }
        assert.doesNotMatch(html, /\son[a-z]+="|style="/);
        nonces.add(nonce);
    }
    assert.equal(nonces.size, 5);
    // A loader that broke is answered by the framework in plain words: there is nothing in it to run.
    const broken = await ctx.request.get('/fragile?mode=throw', { headers: { Accept: 'text/html' } });
    assert.equal(broken.status(), 500);
    assert.match(broken.headers()['content-type'], /^text\/plain/);
    assert.equal((await broken.text()).trim(), '500 Internal Server Error');
    await ctx.close();
});

test('no file of the server’s is given to a browser, by any address', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const addresses = [
        '/.env',
        '/app.php',
        '/cua',
        '/composer.json',
        '/composer.lock',
        '/package.json',
        '/vite.config.ts',
        '/config/app.php',
        '/config/psx.php',
        '/routes/pages.php',
        '/src/Store.php',
        '/storage/acceptance.sqlite',
        '/vendor/autoload.php',
        '/vendor/crabphp/psx/src/Runtime/Kernel.php',
        '/resources/pages/Home.psx',
        '/resources/pages/Home.psx?raw',
        '/resources/layouts/Shell.psx?url',
        '/build/psx/current/manifest.json',
        '/build/psx/current/manifest.php',
        '/assets/psx/../../.env',
        '/assets/psx/..%2f..%2f.env',
        '/assets/psx/%2e%2e/%2e%2e/app.php',
        '/assets/psx/assets/..%5c..%5c..%5c.env',
        '/assets/psx//etc/passwd',
        '/assets/psx/assets/Home.psx',
    ];
    for (const address of addresses) {
        const answer = await ctx.request.get(address, { headers: { Accept: '*/*' }, maxRedirects: 0 });
        const text = await answer.text();
        assert.ok(answer.status() >= 400, `${address} was answered ${answer.status()}`);
        assert.doesNotMatch(text, servers, address);
        assert.doesNotMatch(text, /root:.*:0:0:/, address);
    }
    await ctx.close();
});

test('what a release makes public holds nothing of the server’s: no PHP, no map to the sources, no path of this machine', { skip: built ? false : 'a release’s public tree; development is checked by its own test' }, async () => {
    const root = join(app.dir, 'public');
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name));
    assert.ok(files.length > 10);
    const ctx = await browser.newContext({ baseURL: app.url });
    for (const file of files) {
        assert.match(file, /\.(js|css|svg|png|woff2?)$/, `${file} is public`);
        const text = readFileSync(file, 'latin1');
        assert.doesNotMatch(text, servers, file);
        assert.doesNotMatch(text, /sourceMappingURL/, file);
        assert.ok(!text.includes(app.dir) && !/\/home\/[a-z]+\/|\/tmp\/psx-/.test(text), `${file} names a path of this machine`);
        // And no map is answered for it, should one be asked for.
        const address = `/${file.slice(root.length + 1)}.map`;
        assert.ok((await ctx.request.get(address)).status() >= 400, address);
    }
    // The release itself, with the PHP it was compiled to, lies outside what is served.
    assert.ok(existsSync(join(app.dir, 'build', 'psx', 'current')));
    assert.ok(!existsSync(join(root, 'build')) && !existsSync(join(root, 'psx')));
    await ctx.close();
});

test('Vite, under development, gives a script no file of the server’s either', { skip: built ? 'only `php cua dev` runs Vite' : false }, async t => {
    const hot = readdirSync(app.dir, { recursive: true, withFileTypes: true }).find(entry => entry.isFile() && entry.name === 'hot' && !entry.parentPath.includes('node_modules'));
    assert.ok(hot, 'Vite has not said where it listens');
    const vite = readFileSync(join(hot.parentPath, hot.name), 'utf8').trim();
    const ctx = await browser.newContext({ baseURL: vite });
    const fs = `/@fs${app.dir}`;
    const never = [
        '/.env',
        '/.env?raw',
        '/app.php',
        '/app.php?raw',
        '/config/app.php?raw',
        '/routes/pages.php?url',
        '/src/Store.php?raw',
        '/storage/acceptance.sqlite?url',
        '/vendor/autoload.php?raw',
        '/resources/pages/Home.psx?raw',
        '/resources/pages/Home.psx?url',
        '/resources/pages/Home.psx?inline',
        '/resources/pages/Home.psx?import&raw',
        '/resources/layouts/Shell.psx?raw&import',
        `${fs}/.env`,
        `${fs}/.env?raw`,
        `${fs}/app.php?raw`,
        `${fs}/storage/acceptance.sqlite?raw`,
        `${fs}/vendor/autoload.php`,
        `${fs}/resources/pages/Home.psx?raw`,
        `${fs}/build/psx/current/manifest.php?raw`,
        '/@fs/etc/passwd',
        '/@fs/etc/passwd?raw',
        `${fs}/../../../etc/passwd?raw`,
    ];
    // Everything the browser itself is given for the application's pages, with the maps written
    // into it: the components, never the PHP beside them in the same files.
    const own = await browser.newContext({ baseURL: app.url });
    const { page } = await open(own);
    const given = new Set();
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === new URL(vite).origin && !/^\/(node_modules|@vite|@react-refresh|@id)\b/.test(url.pathname)) {
            given.add(url.pathname + url.search);
        }
    });
    await signIn(page, 'sven');
    for (const [path, shown] of [
        ['/forms', 'forms'],
        ['/upload', 'upload'],
        ['/boxes', 'box-left-count'],
    ]) {
        await page.goto(path);
        await page.getByTestId(shown).waitFor();
    }
    const modules = [...given];
    assert.ok(modules.some(address => /Home/.test(address)) && modules.some(address => /Shell/.test(address)), modules.join(' '));
    for (const address of modules) {
        const code = await (await ctx.request.get(address)).text();
        assert.doesNotMatch(code, servers, address);
        for (const [, map] of code.matchAll(/sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/g)) {
            assert.doesNotMatch(Buffer.from(map, 'base64').toString('utf8'), servers, `the map of ${address}`);
        }
        const mapped = await ctx.request.get(`${address.split('?')[0]}.map`);
        assert.doesNotMatch(await mapped.text(), servers, `${address}.map`);
    }

    // Asked for by hand, while that page is open and listening to Vite.
    for (const address of never) {
        const answer = await ctx.request.get(address, { headers: { Accept: '*/*' } });
        const text = await answer.text();
        assert.doesNotMatch(text, servers, `${address} (${answer.status()})`);
        assert.doesNotMatch(text, /root:.*:0:0:/, address);
    }
    // The raw file is refused outright, also as a module.
    assert.ok((await ctx.request.get('/resources/pages/Home.psx')).status() >= 400);
    // What Vite says of those refusals to the pages that are open, it says without the PHP.
    await page.waitForTimeout(500);
    const overlay = await page.evaluate(() => document.querySelector('vite-error-overlay')?.shadowRoot?.textContent ?? null);
    t.diagnostic(overlay === null ? 'Vite showed no overlay for the refused requests' : `Vite showed an overlay: ${overlay.replace(/\s+/g, ' ').slice(0, 200)}`);
    assert.doesNotMatch(overlay ?? '', servers);
    await own.close();
    await ctx.close();
});
