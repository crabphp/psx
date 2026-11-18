// Moving between pages as a person does: links, the address bar's hash, Back and Forward, where the
// page is scrolled to and what holds the focus, leaving with something unsaved, a navigation
// overtaken by a later one, and what is shown when a page's loader or its component fails.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { eventually, gate, watch } from './lib/harness.mjs';
import { alive, launch, mode, open, target } from './lib/target.mjs';

let app;
let browser;
before(async () => {
    app = await target('navigation');
    browser = await launch();
});
after(async () => {
    await browser?.close();
    await app?.stop();
});

async function start(path = '/long') {
    const ctx = await browser.newContext({ baseURL: app.url, viewport: { width: 900, height: 600 } });
    const { page, errors } = await open(ctx, path);
    await page.evaluate(() => {
        window.sameDocument = true;
    });
    return { ctx, page, errors };
}
const same = page => page.evaluate(() => window.sameDocument === true);
const scrolled = page => page.evaluate(() => Math.round(window.scrollY));
const link = (page, name) => page.getByRole('link', { name, exact: true });
const path = page => page.evaluate(() => location.pathname + location.search + location.hash);

test('a link moves within the document: title, top of the page, focus on the new content, and Back restores where it was', async () => {
    const { ctx, page, errors } = await start();
    const seen = watch(page);
    await page.evaluate(() => window.scrollTo(0, 1500));
    // Pressed with the keyboard, so that the page is not scrolled by the pointer on its way.
    await link(page, 'Next').focus();
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.keyboard.press('Enter');
    await page.getByTestId('long-page').filter({ hasText: '2' }).waitFor();
    assert.equal(await page.title(), 'Long page 2');
    assert.equal(await path(page), '/long?page=2');
    assert.equal(await scrolled(page), 0);
    assert.equal(await same(page), true);
    // The new content holds the focus, and is announced.
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'MAIN');
    await eventually('the page is announced', async () => (await page.locator('#psx-announcer').textContent()) === 'Long page 2');
    // Data only: one request of the protocol's, and no document. A built release fetched nothing
    // else for it; under `php cua dev` Vite hands out modules as they are first used.
    const requests = seen.all();
    assert.deepEqual(
        requests.filter(request => (request.headers.accept ?? '').includes('application/vnd.crab.psx+json')).map(request => request.url),
        ['/long?page=2'],
    );
    assert.equal(requests.filter(request => (request.headers.accept ?? '').includes('text/html')).length, 0);
    if (mode !== 'dev') {
        assert.equal(requests.length, 1);
    }

    await page.evaluate(() => window.scrollTo(0, 700));
    await page.goBack();
    await page.getByTestId('long-page').filter({ hasText: '1' }).waitFor();
    await eventually('page 1 is where it was left', async () => (await scrolled(page)) === 1500);
    assert.equal(await page.title(), 'Long page 1');
    await page.goForward();
    await page.getByTestId('long-page').filter({ hasText: '2' }).waitFor();
    await eventually('page 2 is where it was left', async () => (await scrolled(page)) === 700);
    assert.equal(await same(page), true);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('a hash moves the page to its target without asking the server, and Back returns', async () => {
    const { ctx, page, errors } = await start();
    const seen = watch(page);
    await page.getByTestId('to-line').click();
    await eventually('line 100 is at the top', () =>
        page.evaluate(() => Math.abs(document.getElementById('line-100').getBoundingClientRect().top) < 2),
    );
    assert.equal(await path(page), '/long#line-100');
    assert.deepEqual(seen.all(), []);
    await page.goBack();
    await eventually('the top again', async () => (await scrolled(page)) === 0);
    assert.equal(await path(page), '/long');
    assert.deepEqual(seen.all(), []);
    assert.equal(await same(page), true);

    // A document opened at a hash starts at its target.
    await page.goto('/long?page=3#line-100');
    await eventually('line 100 is at the top of a new document', () =>
        page.evaluate(() => Math.abs(document.getElementById('line-100').getBoundingClientRect().top) < 2),
    );
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('a link the browser should handle is left to it: a new tab, an ordinary route, another site', async () => {
    const { ctx, page, errors } = await start();
    // Control held: the browser opens a tab; this one stays.
    const [tab] = await Promise.all([ctx.waitForEvent('page'), link(page, 'Next').click({ modifiers: ['ControlOrMeta'] })]);
    await tab.getByTestId('long-page').filter({ hasText: '2' }).waitFor();
    assert.equal(await path(page), '/long');
    assert.equal(await same(page), true);
    await tab.close();

    // Another site.
    await page.route('https://example.invalid/', route => route.fulfill({ contentType: 'text/html', body: '<title>outside</title>elsewhere' }));
    await page.getByTestId('outside-link').click();
    await page.waitForURL('https://example.invalid/');
    await page.goBack();
    await page.getByTestId('long-page').filter({ hasText: '1' }).waitFor();

    // An ordinary route of the same application: a document of its own, and Back is a document again.
    await page.evaluate(() => {
        window.sameDocument = true;
    });
    await page.getByTestId('plain-link').click();
    await page.waitForURL('**/plain');
    assert.deepEqual(JSON.parse(await page.locator('body').innerText()), { plain: true });
    await page.goBack();
    await page.getByTestId('long-page').filter({ hasText: '1' }).waitFor();
    assert.equal(await same(page), false);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('a history entry the application did not make is shown by its document, not guessed at', async () => {
    const { ctx, page, errors } = await start();
    await link(page, 'Next').click();
    await page.getByTestId('long-page').filter({ hasText: '2' }).waitFor();
    // Another script's entry, with a state that is not the router's.
    await page.evaluate(() => history.pushState({ someone: 'else' }, '', '/long?page=9'));
    await page.evaluate(() => history.pushState({ someone: 'else' }, '', '/long?page=10'));
    await page.goBack();
    await page.getByTestId('long-page').filter({ hasText: '9' }).waitFor();
    assert.equal(await page.title(), 'Long page 9');
    assert.equal(await same(page), false);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('something unsaved holds a link and Back until the person says stay or leave', async () => {
    const { ctx, page, errors } = await start();
    await link(page, 'Next').click();
    await page.getByTestId('long-page').filter({ hasText: '2' }).waitFor();
    const seen = watch(page);
    await page.getByTestId('make-dirty').click();

    await link(page, 'Next').click();
    await page.getByTestId('held').filter({ hasText: 'held' }).waitFor();
    assert.equal(await path(page), '/long?page=2');
    assert.deepEqual(seen.all(), []);
    await page.getByTestId('stay').click();
    await eventually('nothing is held', async () => (await page.getByTestId('held').textContent()) === '');
    assert.equal(await page.getByTestId('long-page').textContent(), '2');

    // Back, within the document: the address is put back and the step waits.
    await page.goBack();
    await page.getByTestId('held').filter({ hasText: 'held' }).waitFor();
    await eventually('the address is put back', async () => (await path(page)) === '/long?page=2');
    assert.equal(await page.getByTestId('long-page').textContent(), '2');
    assert.deepEqual(seen.all(), []);
    await page.getByTestId('leave').click();
    await page.getByTestId('long-page').filter({ hasText: '1' }).waitFor();
    assert.equal(await path(page), '/long');
    assert.equal(await same(page), true);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('a navigation overtaken by a later one never shows, however late its answer comes', async () => {
    const { ctx, page, errors } = await start();
    await link(page, 'Fragile b').click();
    await page.getByTestId('fragile').filter({ hasText: 'mode b' }).waitFor();
    await link(page, 'Long').click();
    await page.getByTestId('long').waitFor();

    const slow = gate(app.dir, 'fragile.load.a');
    slow.hold();
    await link(page, 'Fragile a').click();
    await slow.arrived();
    assert.equal(await path(page), '/long');
    await link(page, 'Fragile b').click();
    await page.getByTestId('fragile').filter({ hasText: 'mode b' }).waitFor();
    assert.equal(await path(page), '/fragile?mode=b');

    // The page being left says so while the next is on its way.
    await link(page, 'Fragile a').click();
    await page.getByTestId('page-pending').waitFor();
    assert.equal(await page.getByTestId('fragile').textContent().then(text => text.startsWith('mode b')), true);
    await link(page, 'Long').click();
    await page.getByTestId('long').waitFor();
    await slow.open();
    // Both answers for a have had their chance: neither is shown, nor its address.
    await page.waitForLoadState('networkidle');
    assert.equal(await path(page), '/long');
    assert.equal(await page.getByTestId('fragile').count(), 0);
    assert.equal(await same(page), true);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('a loader’s refusal, a loader that breaks and a component that breaks each show their own page, without what broke', async () => {
    const { ctx, page } = await start();

    await link(page, 'Fragile missing').click();
    await page.getByTestId('route-error').filter({ hasText: '404 not_found There is nothing here.' }).waitFor();
    assert.equal(await path(page), '/fragile?mode=missing');
    assert.equal(await same(page), true);
    await link(page, 'Long').click();
    await page.getByTestId('long').waitFor();

    // A loader that throws is nobody's page: the navigation fails, and the page shown stays.
    await link(page, 'Fragile throw').click();
    const alert = page.locator('[data-psx-navigation-error]');
    await alert.filter({ hasText: 'Internal Server Error' }).waitFor();
    assert.equal(await path(page), '/long');
    assert.equal(await page.getByTestId('long-page').textContent(), '1');
    await alert.getByRole('button', { name: 'Dismiss' }).click();
    await eventually('the failure is put away', async () => (await alert.count()) === 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /The loader broke|RuntimeException|Fragile\.psx|#0 /);

    // A component that throws while it renders is caught by its own boundary.
    await page.goto('/long');
    await alive(page);
    await link(page, 'Fragile render').click();
    await page.getByTestId('render-error').filter({ hasText: 'The component broke.' }).waitFor();
    assert.equal(await path(page), '/fragile?mode=render');

    // As documents: the status says what happened, and nothing of the source is in the answer.
    for (const [asked, status] of [
        ['missing', 404],
        ['throw', 500],
    ]) {
        const answer = await ctx.request.get(`/fragile?mode=${asked}`, { headers: { Accept: 'text/html' } });
        assert.equal(answer.status(), status);
        assert.doesNotMatch(await answer.text(), /The loader broke|RuntimeException|Fragile\.psx|#0 |resources\/pages/);
    }
    const shown = await open(ctx, '/fragile?mode=missing');
    await shown.page.getByTestId('route-error').filter({ hasText: '404 not_found There is nothing here.' }).waitFor();
    await ctx.close();
});

test('a part only the browser can make shows its stand-in first and itself once loaded', async () => {
    const { ctx, page, errors } = await start('/lazy');
    await page.getByTestId('clock').filter({ hasText: 'loaded in the browser at /lazy' }).waitFor();
    const html = await (await ctx.request.get('/lazy', { headers: { Accept: 'text/html' } })).text();
    assert.doesNotMatch(html, /data-testid="clock"/);
    if (mode === 'ssr') {
        // The server rendered the stand-in; the browser's module never ran there.
        assert.match(html, /data-testid="clock-fallback"/);
    }
    // Reached by a link as well.
    await page.goto('/long');
    await alive(page);
    await link(page, 'Lazy').click();
    await page.getByTestId('clock').filter({ hasText: 'loaded in the browser at /lazy' }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
});
