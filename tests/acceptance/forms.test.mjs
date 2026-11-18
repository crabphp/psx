// A form sent as a form: what the Enter key, the button pressed, a list of fields, an empty field and
// an absent one each arrive as; what React's useActionState is handed; and what a name the schema
// does not have, or has twice, is answered.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { store, watch } from './lib/harness.mjs';
import { launch, open, target } from './lib/target.mjs';

let app;
let browser;
before(async () => {
    app = await target('forms');
    browser = await launch();
});
after(async () => {
    await browser?.close();
    await app?.stop();
});

const echoed = async page => JSON.parse(await page.getByTestId('echoed').textContent());

test('Enter, a pressed button, a list, an empty field and an absent one each arrive as what they are', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const { page, errors } = await open(ctx, '/forms');
    const seen = watch(page);

    // Enter in a field is the browser pressing the form's first button: its value is sent. An
    // unticked box is absent; an empty text field is the empty string, not null.
    await page.getByLabel('Title').fill('by enter');
    await page.getByLabel('Tag 1').fill('one');
    await page.getByLabel('Title').press('Enter');
    await page.getByTestId('runs').filter({ hasText: '1' }).waitFor();
    assert.deepEqual(await echoed(page), { title: 'by enter', tags: ['one'], note: '', intent: 'save', pinned: false });
    assert.equal(await page.getByTestId('previous-runs').textContent(), '0');
    assert.match(seen.posts()[0].headers['content-type'], /^multipart\/form-data; boundary=/);

    // Sent by no button at all: the button's field is absent, and arrives as its default.
    await page.evaluate(() => document.querySelector('form').requestSubmit());
    await page.getByTestId('runs').filter({ hasText: '2' }).waitFor();
    assert.deepEqual(await echoed(page), { title: 'by enter', tags: ['one'], note: '', intent: null, pinned: false });

    // The button pressed is sent with its value; a list keeps its order; a ticked box is true.
    await page.getByTestId('more-tags').click();
    await page.getByLabel('Tag 2').fill('two');
    await page.getByLabel('Note').fill('a note');
    await page.getByLabel('Pinned').check();
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByTestId('runs').filter({ hasText: '3' }).waitFor();
    assert.deepEqual(await echoed(page), { title: 'by enter', tags: ['one', 'two'], note: 'a note', intent: 'publish', pinned: true });
    // React handed the action the state the run before returned.
    assert.equal(await page.getByTestId('previous-runs').textContent(), '2');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByTestId('runs').filter({ hasText: '4' }).waitFor();
    assert.equal((await echoed(page)).intent, 'save');
    assert.equal(seen.posts().length, 4);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('a refusal the action expected leaves the draft as it was typed, and is sent once', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const { page, errors } = await open(ctx, '/forms');
    const seen = watch(page);
    const before = store(app.dir).writes('submit').length;

    await page.getByLabel('Title').fill('   ');
    await page.getByLabel('Tag 1').fill('kept');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByTestId('runs').filter({ hasText: '1' }).waitFor();
    assert.deepEqual(JSON.parse(await page.getByTestId('problem').textContent()), { title: ['is needed'] });
    assert.equal(await page.getByLabel('Title').inputValue(), '   ');
    assert.equal(await page.getByLabel('Tag 1').inputValue(), 'kept');
    assert.equal(seen.posts().length, 1);
    assert.equal(store(app.dir).writes('submit').length, before);

    // Corrected and sent again by the person: the draft is what is sent.
    await page.getByLabel('Title').fill('now with a title');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByTestId('runs').filter({ hasText: '2' }).waitFor();
    assert.deepEqual(await echoed(page), { title: 'now with a title', tags: ['kept'], note: '', intent: 'save', pinned: false });
    assert.equal(store(app.dir).writes('submit').length, before + 1);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('a form whose names are ambiguous, sparse or of the wrong kind is refused before the action runs', async () => {
    const ctx = await browser.newContext({ baseURL: app.url });
    const { page } = await open(ctx, '/forms');
    const seen = watch(page);
    await page.getByLabel('Title').fill('the real one');
    await page.getByLabel('Title').press('Enter');
    await page.getByTestId('runs').filter({ hasText: '1' }).waitFor();
    const real = seen.posts()[0];
    const headers = Object.fromEntries(Object.entries(real.headers).filter(([name]) => name.startsWith('x-psx-') || name === 'accept'));
    const before = store(app.dir).writes('submit').length;

    const send = fields =>
        page.evaluate(
            async ({ url, headers, fields }) => {
                const form = new FormData();
                for (const [name, value] of fields) {
                    form.append(name, value);
                }
                const answer = await fetch(url, { method: 'POST', headers, body: form });
                const text = await answer.text();
                let code = null;
                try {
                    code = JSON.parse(text).problem?.code ?? null;
                } catch {
                    // Not an envelope.
                }
                return { status: answer.status, code };
            },
            { url: real.url, headers, fields },
        );

    assert.equal((await send([['title', 'fine'], ['tags[]', 'a']])).status, 200);
    // A field the input does not declare is not an error and is not bound: the action is handed its
    // declared fields only (the binder's rule, as on any Crab route).
    assert.equal((await send([['title', 'with a stray field'], ['admin', 'true']])).status, 200);
    const refused = {
        'the same scalar twice': [[['title', 'one'], ['title', 'two']], 400],
        'a list appended to and indexed': [[['title', 't'], ['tags[]', 'a'], ['tags[1]', 'b']], 400],
        'a list with a gap': [[['title', 't'], ['tags[0]', 'a'], ['tags[2]', 'c']], 400],
        'a name that is not one': [[['title', 't'], ['tags[', 'a']], 400],
        'a word where a boolean goes': [[['title', 't'], ['pinned', 'perhaps']], 422],
        'a value the enumeration does not have': [[['title', 't'], ['intent', 'destroy']], 422],
        'nothing that is needed': [[['note', 'only a note']], 422],
    };
    for (const [what, [fields, status]] of Object.entries(refused)) {
        const answer = await send(fields);
        assert.equal(answer.status, status, `${what}: ${JSON.stringify(answer)}`);
    }
    // One write for each form that was fine; none for any that was refused.
    assert.deepEqual(
        store(app.dir).writes('submit').slice(before).map(write => write.detail),
        ['fine', 'with a stray field'],
    );
    await ctx.close();
});
