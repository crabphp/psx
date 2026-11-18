// What stays and what starts again as pages change: a layout's own state, a tenant's layout, and
// two instances of one component with a query and an action of its own.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { store, watch } from './lib/harness.mjs';
import { launch, open, signIn, target } from './lib/target.mjs';

let app;
let browser;
before(async () => {
    app = await target('layout');
    browser = await launch();
});
after(async () => {
    await browser?.close();
    await app?.stop();
});

test('a layout keeps its state across the pages under it, and a tenant’s layout starts again for another tenant', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const { page, errors } = await open(ctx);
    await signIn(page, 'lena');
    await page.evaluate(() => {
        window.sameDocument = true;
    });
    const link = name => page.getByRole('link', { name, exact: true }).click();

    await page.getByTestId('shell-clicks').click();
    await page.getByTestId('shell-clicks').click();
    await page.getByTestId('shell-draft').fill('kept by the shell');
    await link('Other');
    await page.getByTestId('other').waitFor();
    await link('Acme');
    await page.getByTestId('tenant-name').filter({ hasText: 'acme' }).waitFor();
    assert.equal(await page.getByTestId('shell-clicks').textContent(), '2');
    assert.equal(await page.getByTestId('shell-draft').inputValue(), 'kept by the shell');

    // The tenant's layout has state of its own, kept between that tenant's pages.
    for (let click = 0; click < 3; click++) {
        await page.getByTestId('tenant-clicks').click();
    }
    await page.getByTestId('tenant-draft').fill('about acme');
    await link('Members');
    await page.getByTestId('tenant-page').filter({ hasText: 'members of acme: acme-one, acme-two' }).waitFor();
    assert.equal(await page.getByTestId('tenant-clicks').textContent(), '3');
    assert.equal(await page.getByTestId('tenant-draft').inputValue(), 'about acme');

    // Another tenant is another layout: nothing of acme's is carried into it. The shell stays.
    await link('Globex');
    await page.getByTestId('tenant-name').filter({ hasText: 'globex' }).waitFor();
    await page.getByTestId('tenant-page').filter({ hasText: 'overview of globex' }).waitFor();
    assert.equal(await page.getByTestId('tenant-clicks').textContent(), '0');
    assert.equal(await page.getByTestId('tenant-draft').inputValue(), '');
    assert.equal(await page.getByTestId('shell-clicks').textContent(), '2');
    assert.equal(await page.getByTestId('shell-draft').inputValue(), 'kept by the shell');
    assert.equal(await page.title(), 'Tenant globex');

    // Back to acme: its layout is made anew, not handed globex's or a stale one.
    await page.goBack();
    await page.getByTestId('tenant-name').filter({ hasText: 'acme' }).waitFor();
    assert.equal(await page.getByTestId('tenant-clicks').textContent(), '0');
    assert.equal(await page.getByTestId('shell-clicks').textContent(), '2');
    assert.equal(await page.evaluate(() => window.sameDocument), true);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('two instances of a component with its own query and action each read and write their own resource', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const { page, errors } = await open(ctx, '/boxes');
    const count = async box => Number((await page.getByTestId(`box-${box}-count`).textContent()).split('=')[1]);
    await page.getByTestId('box-left-count').filter({ hasText: 'left=' }).waitFor();
    await page.getByTestId('box-right-count').filter({ hasText: 'right=' }).waitFor();
    const [left, right] = [await count('left'), await count('right')];
    const seen = watch(page);

    await page.getByTestId('box-left-add').click();
    await page.getByTestId('box-left-count').filter({ hasText: `left=${left + 1}` }).waitFor();
    await page.getByTestId('box-left-add').click();
    await page.getByTestId('box-left-count').filter({ hasText: `left=${left + 2}` }).waitFor();
    await page.getByTestId('box-right-add').click();
    await page.getByTestId('box-right-count').filter({ hasText: `right=${right + 1}` }).waitFor();
    await page.waitForLoadState('networkidle');

    assert.equal(await count('left'), left + 2);
    assert.equal(await count('right'), right + 1);
    // Each write went to its own box's address, and made only its own box's answer stale.
    const sent = seen.all().map(request => `${request.method} ${request.url.replace(/[a-f0-9]{16}$/, '*')}`);
    assert.deepEqual(sent, [
        'POST /box/left/_psx/a/*',
        'GET /box/left/_psx/q/*',
        'POST /box/left/_psx/a/*',
        'GET /box/left/_psx/q/*',
        'POST /box/right/_psx/a/*',
        'GET /box/right/_psx/q/*',
    ]);
    assert.deepEqual(errors, []);
    await ctx.close();
});
