// Signing in, out and over in real tabs, against the application's own revisioned AuthState
// (app/src/Session.php), ordinary Crab guards and generated #[Action(auth: true)] bindings.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { eventually, gate, store, watch } from './lib/harness.mjs';
import { alive, launch, open, shown, signIn, target } from './lib/target.mjs';

let app;
let browser;
before(async () => {
    app = await target('auth');
    browser = await launch();
});
after(async () => {
    await browser?.close();
    await app?.stop();
});

const context = () => browser.newContext({ baseURL: app.url });
const said = (page, id, pattern) => page.getByTestId(id).filter({ hasText: pattern }).waitFor();
const cookie = async (ctx, name) => (await ctx.cookies()).find(found => found.name === name)?.value ?? null;

test('one tab signs in, over and out without a write sent twice, and nothing of who was signed in stays', async () => {
    const ctx = await context();
    const { page, errors } = await open(ctx);
    const seen = watch(page);
    const before = { in: store(app.dir).count('signIn'), over: store(app.dir).count('switchTo'), out: store(app.dir).count('signOut') };

    // A visitor is sent to the sign-in page; a wrong password is a refusal that keeps the page and the draft.
    await page.goto('/');
    assert.equal(new URL(page.url()).pathname, '/login');
    await alive(page);
    await page.getByLabel('Account').fill('alice');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await said(page, 'login-said', 'refused:does not match');
    assert.equal(await page.getByLabel('Account').inputValue(), 'alice');
    assert.equal(seen.all().filter(request => request.method === 'GET' && request.url === '/login').length, 1);
    assert.equal(await cookie(ctx, 'acceptance_session'), null);

    await page.getByLabel('Password').fill('pw-alice');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByTestId('home-account').filter({ hasText: 'alice' }).waitFor();
    assert.equal(await page.title(), 'Home of alice');
    await said(page, 'mine', 'alice: private of alice');
    assert.equal(seen.posts().length, 2);
    assert.equal(store(app.dir).count('signIn') - before.in, 1);

    // State of alice's own: the layout's, the page's draft, a query's answer.
    await page.getByTestId('shell-clicks').click();
    await page.getByTestId('shell-draft').fill('typed by alice');
    await page.getByTestId('draft').fill('a draft of alice');
    seen.reset();
    await page.getByTestId('switch-bob').click();
    await page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();
    await said(page, 'mine', 'bob: private of bob');
    assert.equal(await page.title(), 'Home of bob');
    assert.doesNotMatch(await shown(page), /alice/);
    assert.equal(await page.getByTestId('shell-clicks').textContent(), '0');
    assert.equal(await page.getByTestId('shell-draft').inputValue(), '');
    assert.equal(await page.getByTestId('draft').inputValue(), '');
    // It stayed one document: the switch was one POST, and the page and its query were read again as bob.
    assert.deepEqual(
        seen.all().map(request => request.method),
        ['POST', 'GET', 'GET'],
    );
    assert.equal(store(app.dir).count('switchTo') - before.over, 1);

    seen.reset();
    await page.getByTestId('sign-out').click();
    await page.getByTestId('greeting').waitFor();
    assert.equal(new URL(page.url()).pathname, '/login');
    assert.doesNotMatch(await shown(page), /bob|alice|secret|private/);
    assert.equal(seen.posts().length, 1);
    assert.equal(store(app.dir).count('signOut') - before.out, 1);
    assert.equal(await cookie(ctx, 'acceptance_session'), null);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('another tab of the same browser hears of the change, drops what it held and reads again, sending nothing', async () => {
    const ctx = await context();
    const first = await open(ctx);
    await signIn(first.page, 'carol');
    const second = await open(ctx, '/');
    await said(second.page, 'mine', 'carol: private of carol');
    await second.page.getByTestId('draft').fill('carol was typing');
    await second.page.getByTestId('shell-clicks').click();
    const seen = watch(second.page);

    await first.page.getByTestId('switch-bob').click();
    await first.page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();

    await second.page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();
    await said(second.page, 'mine', 'bob: private of bob');
    assert.equal(await second.page.title(), 'Home of bob');
    assert.doesNotMatch(await shown(second.page), /carol/);
    assert.equal(await second.page.getByTestId('draft').inputValue(), '');
    assert.equal(await second.page.getByTestId('shell-clicks').textContent(), '0');
    assert.equal(seen.posts().length, 0);
    assert.ok(seen.all().every(request => request.method === 'GET'));
    assert.deepEqual([...first.errors, ...second.errors], []);
    await ctx.close();
});

test('an answer asked as who was signed in before arrives late and is shown to nobody', async () => {
    const ctx = await context();
    const first = await open(ctx);
    await signIn(first.page, 'dave');
    const second = await open(ctx, '/other');
    await second.page.getByTestId('other').waitFor();
    const titles = [];
    await second.page.exposeFunction('noteTitle', title => titles.push(title));
    await second.page.evaluate(() => {
        new MutationObserver(() => window.noteTitle(document.title)).observe(document.head, { childList: true, subtree: true, characterData: true });
    });

    // The second tab asks for dave's home, and the answer is held on the server, made as dave.
    const held = gate(app.dir, 'home.load.dave');
    held.hold();
    await second.page.getByRole('link', { name: 'Home', exact: true }).click();
    await held.arrived();

    // Meanwhile the first tab signs over to bob.
    await first.page.getByTestId('switch-bob').click();
    await first.page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();
    await second.page.getByTestId('me').filter({ hasText: 'bob' }).waitFor();

    await held.open();
    // Let the late answer reach the tab, then see that it changed nothing.
    await eventually('the late answer to be dealt with', async () => (await second.page.getByTestId('me').textContent()) === 'bob');
    await second.page.waitForLoadState('networkidle');
    assert.doesNotMatch(await shown(second.page), /dave/);
    // The late answer was dave's home: neither it nor its title was ever put on the page.
    assert.ok(!titles.includes('Home of dave'), `the late answer's title was shown: ${titles.join(' | ')}`);
    assert.equal(await second.page.getByTestId('home').count(), 0);
    assert.equal(new URL(second.page.url()).pathname, '/other');
    assert.deepEqual([...first.errors, ...second.errors], []);
    await ctx.close();
});

test('while a change of who is signed in is under way no write is sent, and none is sent later on its own', async () => {
    const ctx = await context();
    const { page, errors } = await open(ctx);
    await signIn(page, 'erin');
    const seen = watch(page);
    const notes = store(app.dir).count('note');

    const held = gate(app.dir, 'switch.erin');
    held.hold();
    await page.getByTestId('switch-bob').click();
    await held.arrived();
    // The switch is on its way and unanswered: a save now is refused in the browser.
    await page.getByTestId('draft').fill('written during the change');
    await page.getByTestId('save').click();
    await said(page, 'home-said', 'failed:auth:not-sent');
    assert.equal(seen.posts().length, 1);

    await held.open();
    await page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(seen.posts().length, 1, 'the refused save was sent later');
    assert.equal(store(app.dir).count('note'), notes);
    assert.doesNotMatch(await shown(page), /erin|written during the change/);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('a sign-out whose answer is lost is not sent again, and leaves nothing private on the page', async () => {
    const ctx = await context();
    const { page } = await open(ctx);
    await signIn(page, 'frank');
    const outs = store(app.dir).count('signOut');
    let posts = 0;
    // The server does it and answers; the answer never reaches the page.
    await page.route('**/_psx/a/**', async route => {
        posts++;
        await route.fetch();
        await route.abort('connectionreset');
    });
    await page.getByTestId('sign-out').click();
    await eventually('the page to stop showing frank', async () => !/frank/.test(await shown(page)));
    await page.waitForLoadState('networkidle');
    assert.equal(posts, 1);
    assert.equal(store(app.dir).count('signOut') - outs, 1);
    assert.doesNotMatch(await shown(page), /frank|secret|private of/);
    // Whatever the page now says, a new document is the visitor's sign-in page.
    await page.unroute('**/_psx/a/**');
    await page.goto('/');
    assert.equal(new URL(page.url()).pathname, '/login');
    await ctx.close();
});

test('a write that failed after it was done is an unknown outcome, sent once', async () => {
    const ctx = await context();
    const { page } = await open(ctx);
    await signIn(page, 'grace');
    const seen = watch(page);
    const done = store(app.dir).count('writeThenFail');
    await page.getByTestId('write-then-fail').click();
    await said(page, 'home-said', 'failed:server:unknown');
    await page.waitForLoadState('networkidle');
    assert.equal(seen.posts().length, 1);
    assert.equal(store(app.dir).count('writeThenFail') - done, 1);
    await ctx.close();
});

test('two tabs sign in at once: the later one is refused by the revision, no cookie of it is kept, and both end as who is signed in', async () => {
    const ctx = await context();
    const first = await open(ctx, '/login');
    const second = await open(ctx, '/login');
    const ins = store(app.dir).count('signIn');
    const seen = watch(first.page);

    // The first tab's sign-in as heidi is held on the server before it changes anything.
    const held = gate(app.dir, 'signin.heidi');
    held.hold();
    await first.page.getByLabel('Account').fill('heidi');
    await first.page.getByLabel('Password').fill('pw-heidi');
    await first.page.getByRole('button', { name: 'Sign in' }).click();
    await held.arrived();

    // The second tab signs in as ivan, and is answered first.
    await second.page.getByLabel('Account').fill('ivan');
    await second.page.getByLabel('Password').fill('pw-ivan');
    await second.page.getByRole('button', { name: 'Sign in' }).click();
    await second.page.getByTestId('home-account').filter({ hasText: 'ivan' }).waitFor();
    const credential = await cookie(ctx, 'acceptance_session');

    // Now the first one goes on: it saw the revision of before, and is refused without a cookie.
    await held.open();
    await eventually('the first tab to settle', async () => !/Nobody is signed in/.test(await shown(first.page)));
    await first.page.waitForLoadState('networkidle');
    assert.equal(await cookie(ctx, 'acceptance_session'), credential, 'the late answer changed the credential');
    assert.equal(store(app.dir).count('signIn') - ins, 1);
    assert.deepEqual(store(app.dir).writes('signIn').at(-1).account, 'ivan');
    assert.equal(seen.posts().length, 1);
    assert.doesNotMatch(await shown(first.page), /heidi/);
    // Either tab, loaded again, is ivan's.
    await first.page.goto('/');
    await first.page.getByTestId('home-account').filter({ hasText: 'ivan' }).waitFor();
    await second.page.reload();
    await second.page.getByTestId('home-account').filter({ hasText: 'ivan' }).waitFor();
    await ctx.close();
});

test('a tab that did not hear of the change sends its write as who the browser is now, and is settled before it shows the answer as its own', async () => {
    const ctx = await context();
    const first = await open(ctx);
    await signIn(first.page, 'judy');
    // A tab without the channel the others tell each other by.
    const second = await ctx.newPage();
    await second.addInitScript(() => {
        delete window.BroadcastChannel;
    });
    await second.goto('/');
    await said(second, 'mine', 'judy: private of judy');
    const seen = watch(second);

    await first.page.getByTestId('switch-bob').click();
    await first.page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();
    assert.equal(await second.getByTestId('me').textContent(), 'judy');

    await second.getByTestId('draft').fill('sent from the tab that did not hear');
    await second.getByTestId('save').click();
    await second.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();
    await second.waitForLoadState('networkidle');
    assert.equal(seen.posts().length, 1);
    assert.doesNotMatch(await shown(second), /judy/);
    // The server took it as the browser's current user: that is whose note it is.
    assert.equal(store(app.dir).note('judy'), null);
    assert.equal(store(app.dir).note('bob').text, 'sent from the tab that did not hear');
    await ctx.close();
});

test('a credential of an earlier revision is refused before anything is entered, and the page that held it shows nothing private', async () => {
    const ctx = await context();
    const { page } = await open(ctx);
    await signIn(page, 'kim');
    // A second browser profile with a copy of the first one's cookies as they are now.
    const copy = await browser.newContext({ baseURL: app.url, storageState: await ctx.storageState() });
    const stale = await open(copy, '/');
    await said(stale.page, 'mine', 'kim: private of kim');
    const seen = watch(stale.page);
    const notes = store(app.dir).count('note');
    const outs = store(app.dir).count('signOut');

    // The first profile signs over: the copy's credential is of the revision before.
    await page.getByTestId('switch-bob').click();
    await page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();

    // An ordinary write with it is refused before the action: a result, and nothing written.
    await stale.page.getByTestId('draft').fill('with an old credential');
    await stale.page.getByTestId('save').click();
    await said(stale.page, 'home-said', 'refused');
    assert.equal(store(app.dir).count('note'), notes);

    // An action that changes who is signed in is refused the same way, and that settles the page:
    // read again with the old credential it is nobody's, so nothing private stays on it.
    await stale.page.getByTestId('sign-out').click();
    await eventually('the stale page to stop showing kim', async () => !/kim/.test(await shown(stale.page)));
    await stale.page.waitForLoadState('networkidle');
    assert.equal(store(app.dir).count('signOut'), outs);
    assert.equal(seen.posts().length, 2);
    assert.doesNotMatch(await shown(stale.page), /kim|secret|private of/);
    // The first profile is untouched by any of it.
    await page.reload();
    await page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();
    await copy.close();
    await ctx.close();
});

test('a tab whose first page is still loading its code when who is signed in changes never shows the page it arrived with', async () => {
    const ctx = await context();
    const first = await open(ctx);
    await signIn(first.page, 'liam');

    // A second tab of the same browser: its document arrives, as liam, and the code of its page is held.
    const second = await open(ctx);
    let arrived = 0;
    let letCode;
    const code = new Promise(resolve => {
        letCode = resolve;
    });
    await second.page.route(
        url => /\/Home\.psx/.test(url.pathname),
        async route => {
            arrived++;
            await code;
            await route.continue();
        },
    );
    // And so is what the page is read again with, once it hears of the change.
    let asked = 0;
    let letAnswer;
    const answer = new Promise(resolve => {
        letAnswer = resolve;
    });
    await second.page.route(
        url => url.pathname === '/',
        async route => {
            if ((route.request().headers().accept ?? '').includes('application/vnd.crab.psx+json')) {
                asked++;
                await answer;
            }
            await route.continue();
        },
    );
    await second.page.goto('/', { waitUntil: 'commit' });
    await eventually('the page’s code to be asked for', () => arrived > 0);

    // The first tab signs over to bob while the second is still waiting for its code.
    await first.page.getByTestId('switch-bob').click();
    await first.page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();
    await eventually('the second tab to read its page again', () => asked > 0);
    // It heard: whatever of liam's the document brought is out of it, the server's markup too.
    assert.doesNotMatch(await shown(second.page), /liam/);
    // READY-C02: and the application itself stands in its place, waiting, before that code is
    // there. (It shows nothing while it waits, so it is looked for and not waited to be seen.)
    await second.page.locator('main[role="status"]').waitFor({ state: 'attached' });
    assert.equal(arrived > 0 && (await second.page.getByTestId('home-account').count()) === 0, true);

    // The code arrives now, late: the page the document arrived with was liam's, and is not shown.
    letCode();
    await second.page.waitForLoadState('load');
    await second.page.waitForTimeout(400);
    assert.doesNotMatch(await shown(second.page), /liam/);
    assert.equal(await second.page.getByTestId('home-account').count(), 0);

    // The answer read as who the browser is now arrives: that is what the tab shows.
    letAnswer();
    await second.page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();
    await said(second.page, 'mine', 'bob: private of bob');
    assert.equal(await second.page.title(), 'Home of bob');
    assert.doesNotMatch(await shown(second.page), /liam/);
    // And it is a working page: its history and its links are listened to.
    await second.page.getByRole('link', { name: 'Other', exact: true }).click();
    await second.page.getByTestId('other').waitFor();
    await second.page.goBack();
    await second.page.getByTestId('home-account').filter({ hasText: 'bob' }).waitFor();
    assert.deepEqual(second.errors, []);
    await ctx.close();
});
