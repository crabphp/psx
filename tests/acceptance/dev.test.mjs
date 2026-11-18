// Working on the pages under the one `php cua dev`: an edit to a page's TSX and to its PHP, a page
// added, edits that cannot be built, a page taken away. Each is seen by an open tab, a server is
// started anew only when the pages' PHP changed, what cannot be built leaves the last that could
// in place, PHP and scripts alike, and nothing goes round in circles.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { eventually, pause } from './lib/harness.mjs';
import { alive, launch, mode, open, target } from './lib/target.mjs';

const only = mode === 'dev' ? false : 'only `php cua dev` builds as the pages are edited';
let app;
let browser;
let ctx;
let tab;
let watching;
/** Every server `php cua dev` started, as it said so: the release it serves and when. */
const servers = [];
/** Every document the open tab loaded. */
let documents = 0;

before(async () => {
    if (only) {
        return;
    }
    app = await target('dev', { own: true });
    browser = await launch();
    ctx = await browser.newContext({ baseURL: app.url });
    servers.push(generation());
    watching = setInterval(() => {
        const now = generation();
        if (now !== servers.at(-1)) {
            servers.push(now);
        }
    }, 25);
    tab = await open(ctx, '/fragile?mode=b');
    tab.page.on('load', () => documents++);
});
after(async () => {
    clearInterval(watching);
    await browser?.close();
    await app?.stop();
});

const generation = () => {
    try {
        return readFileSync(join(app.dir, '.psx', 'generation'), 'utf8');
    } catch {
        return '';
    }
};
/** The release the server of `php cua dev` runs: the last that could be compiled. */
const compiled = () => readlinkSync(join(app.dir, 'build', 'psx', 'dev', 'current'));
const file = name => join(app.dir, name);
const edit = (name, from, to) => {
    const text = readFileSync(file(name), 'utf8');
    assert.ok(text.includes(from), `${name} has no "${from}"`);
    writeFileSync(file(name), text.replace(from, to));
};
const get = path => ctx.request.get(path, { headers: { Accept: 'text/html' } });
/** What a page's document carries for its page: the data its loader gave. */
async function data(path) {
    const answer = await get(path);
    const found = /<script type="application\/json" id="psx-bootstrap">([\s\S]*?)<\/script>/.exec(await answer.text());
    return found === null ? `${answer.status()}` : JSON.parse(found[1]).envelope.nodes?.at(-1)?.data;
}
/**
 * Waits until nothing more happens: no server started and no document loaded for a good while.
 * What goes round in circles never gets there, and is said.
 */
async function settled(what) {
    const until = Date.now() + 20_000;
    for (;;) {
        const [started, loaded] = [servers.length, documents];
        await pause(2500);
        if (servers.length === started && documents === loaded) {
            return;
        }
        assert.ok(Date.now() < until, `${what}: servers are still started or documents loaded (${servers.length} servers, ${documents} documents)`);
    }
}

const added = text => `<script lang="php">
final readonly class Greeting
{
    public function __construct(public string $text) {}
}

final readonly class Server
{
    public function load(): Greeting
    {
        return new Greeting('${text}');
    }
}
</script>
import type { Props } from '@psx/types/pages/Added';

export default function Added({ data }: Props) {
    return <main data-testid="added">added: {data.text}</main>;
}
`;
const route = "    $pages->page('/added', 'resources/pages/Added.psx')->name('added');\n";

test('an edit to a page’s TSX shows in the open tab with no new server; an edit to its PHP starts one, and the tab shows what it gives', { skip: only }, async t => {
    await tab.page.getByTestId('fragile').filter({ hasText: 'mode b' }).waitFor();
    const [started, loaded] = [servers.length, documents];

    edit('resources/pages/Fragile.psx', 'mode {data.mode}', 'kind {data.mode}');
    await tab.page.getByTestId('fragile').filter({ hasText: 'kind b' }).waitFor();
    await settled('after the TSX was edited');
    assert.equal(servers.length, started, 'the TSX alone started no server');
    t.diagnostic(`a TSX edit: ${documents - loaded} document load(s), no new server`);
    assert.ok(documents - loaded <= 1);

    const before = [servers.length, documents];
    edit('resources/pages/Fragile.psx', 'default => new Outcome($mode),', "default => new Outcome($mode . '!'),");
    await tab.page.getByTestId('fragile').filter({ hasText: 'kind b!' }).waitFor();
    await settled('after the PHP was edited');
    assert.equal(servers.length - before[0], 1, 'the PHP started one server');
    assert.equal(documents - before[1], 1, 'and the tab loaded its document once');
    assert.deepEqual(tab.errors, []);
});

test('a page that is added is served and shown, built once', { skip: only }, async t => {
    const [before, loaded] = [servers.length, documents];
    writeFileSync(file('resources/pages/Added.psx'), added('first'));
    edit('routes/pages.php', "    $pages->page('/long',", `${route}    $pages->page('/long',`);
    await eventually('the added page to be served', async () => (await data('/added'))?.text === 'first', 30_000);
    await eventually('the server that serves it to have said it started', () => servers.length > before);
    await settled('after a page was added');
    t.diagnostic(`a page added (its file, then its declaration): ${servers.length - before} server(s) started, ${documents - loaded} document load(s) in the open tab`);
    assert.ok(servers.length - before >= 1 && servers.length - before <= 2);
    // The open tab loads its document for a server that is another, and once more where the list
    // of pages its scripts are built from changed: so many times, and then no more.
    assert.ok(documents - loaded >= 1 && documents - loaded <= servers.length - before + 1);

    const page = await open(ctx, '/added');
    await page.page.getByTestId('added').filter({ hasText: 'added: first' }).waitFor();
    assert.deepEqual(page.errors, []);
    await page.page.close();
    // And the tab that was open all along is still a working page.
    await tab.page.getByRole('link', { name: 'Fragile a', exact: true }).click();
    await tab.page.getByTestId('fragile').filter({ hasText: 'kind a!' }).waitFor();
    assert.deepEqual(tab.errors, []);
});

test('an edit that cannot be built leaves the last that could, PHP and scripts alike, and the next good edit is served', { skip: only }, async t => {
    const page = await open(ctx, '/added');
    await page.page.getByTestId('added').filter({ hasText: 'added: first' }).waitFor();
    for (const [what, breakIt, said] of [
        [
            'PHP that cannot be parsed',
            () => edit('resources/pages/Added.psx', "return new Greeting('first');", "return new Greeting('broken'"),
            /Added\.psx/,
        ],
        [
            'a loader that does not say what it returns',
            () => edit('resources/pages/Added.psx', 'public function load(): Greeting', 'public function load()'),
            /Added\.psx/,
        ],
        [
            'a declaration of a page that is not there',
            () => edit('routes/pages.php', route, `${route}    $pages->page('/absent', 'resources/pages/Absent.psx')->name('absent');\n`),
            /Absent\.psx/,
        ],
    ]) {
        const [started, release, output] = [servers.length, compiled(), app.output().length];
        const good = [readFileSync(file('resources/pages/Added.psx'), 'utf8'), readFileSync(file('routes/pages.php'), 'utf8')];
        breakIt();
        // It is said, where the person working reads it.
        await eventually(`${what} to be said`, () => said.test(app.output().slice(output)), 30_000);
        await settled(`after ${what}`);
        // The last that could be built is what runs: its PHP, and the scripts that go with it.
        assert.equal(compiled(), release, what);
        assert.equal(servers.length, started, `${what} started no server`);
        assert.equal((await data('/added'))?.text, 'first', what);
        assert.equal((await get('/long')).status(), 200, what);
        assert.equal((await get('/absent')).status(), 404, what);
        await page.page.reload();
        await alive(page.page);
        await page.page.getByTestId('added').filter({ hasText: 'added: first' }).waitFor();
        // Put right, exactly as it was: nothing is left of the attempt.
        writeFileSync(file('resources/pages/Added.psx'), good[0]);
        writeFileSync(file('routes/pages.php'), good[1]);
        await pause(1500);
        assert.equal((await data('/added'))?.text, 'first', `${what}, put right`);
    }
    await settled('after what could not be built was put right');

    // And an edit that can be built is served as any other.
    const before = servers.length;
    edit('resources/pages/Added.psx', "new Greeting('first')", "new Greeting('second')");
    await page.page.getByTestId('added').filter({ hasText: 'added: second' }).waitFor();
    await settled('after the good edit');
    assert.equal(servers.length - before, 1);
    t.diagnostic(`three edits that could not be built started no server; the good edit after them started one`);
    await page.page.close();
});

test('a page that is taken away is gone, and the rest is served as before', { skip: only }, async t => {
    const [before, loaded] = [servers.length, documents];
    edit('routes/pages.php', route, '');
    rmSync(file('resources/pages/Added.psx'));
    await eventually('the page to be gone', async () => (await get('/added')).status() === 404, 30_000);
    await eventually('the server without it to have said it started', () => servers.length > before);
    await settled('after a page was taken away');
    t.diagnostic(`a page taken away (its declaration, then its file): ${servers.length - before} server(s) started, ${documents - loaded} document load(s) in the open tab`);
    assert.ok(servers.length - before >= 1 && servers.length - before <= 2);
    assert.ok(documents - loaded >= 1 && documents - loaded <= servers.length - before + 1);
    assert.equal((await data('/fragile?mode=z'))?.mode, 'z!');
    assert.equal(existsSync(file('resources/pages/Added.psx')), false);
    await tab.page.getByRole('link', { name: 'Fragile b', exact: true }).click();
    await tab.page.getByTestId('fragile').filter({ hasText: 'kind b!' }).waitFor();
    assert.deepEqual(tab.errors, []);
});
