// @vitest-environment node
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { psx } from '../src/vite.js';

/**
 * R1-B01: real Vite builds, with the real plugin, of applications that name a private file as a
 * file. Nothing here is a mock of Vite: the transforms that read files without asking a plugin
 * are the ones under test. Only a made-up sentinel stands where a secret would.
 */

const SENTINEL = 'PSX_PRIVATE_SENTINEL_Q7';
const here = dirname(fileURLToPath(import.meta.url));
const bindings = resolve(here, '../src/bindings.ts');
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);
/** Past Vite's limit for writing an asset into the script: it is emitted as a file of its own. */
const padding = `// ${'x'.repeat(100)}\n`.repeat(80);

const php = (large = false): string =>
    `<script lang="php">\n// ${SENTINEL}\nfunction load(): string { return '${SENTINEL}'; }\n${large ? padding : ''}`;
const page = (large = false): string =>
    `${php(large)}</script>\nexport default function Page() {\n    return null;\n}\n`;

let root = '';
const saved = { ...process.env };

function file(path: string, content: string | Buffer): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
}

/** An application as the compiler leaves one: the .psx files, and beside them what a browser may have. */
function application(options: { large?: boolean } = {}): void {
    root = mkdtempSync(join(tmpdir(), 'psx-vite-'));
    file('package.json', '{"type":"module"}');
    file('resources/pages/Private.psx', page(options.large));
    file('resources/secret.php', php(options.large));
    file('resources/logo.png', png);
    file('config/app.php', php());
    file('config/private.json', `{"credential":"${SENTINEL}"}`);
    file('config/keys.txt', `key ${SENTINEL}\n`);
    file('config/secrets.ts', `export const secret = '${SENTINEL}';\n`);
    file('build/psx/private-manifest.json', `{"server":"${SENTINEL}"}`);
    file('storage/app/export.json', `{"row":"${SENTINEL}"}`);
    file('storage/app/photo.png', png);
    file('database/seed.sql', `insert into users values ('${SENTINEL}');\n`);
    file('app/Secrets.js', `export default '${SENTINEL}';\n`);
    file('routes/map.json', `{"route":"${SENTINEL}"}`);
    file('resources/data/public.json', '{"greeting":"hello"}');
    file('vendor/acme/widgets/js/package.json', '{"name":"@acme/widgets","type":"module","main":"index.js"}');
    file('vendor/acme/widgets/js/index.js', `export const widget = 'a widget for the browser';\n`);
    file('vendor/acme/widgets/src/notes.json', `{"note":"${SENTINEL}"}`);
    // A package of npm's, as `npm install` leaves one, and one whose folder is a link into vendor/.
    file('node_modules/gadgets/package.json', '{"name":"gadgets","type":"module","main":"index.js"}');
    file('node_modules/gadgets/index.js', `export const gadget = 'a gadget of npm';\n`);
    symlinkSync(join(root, 'vendor/acme/widgets/js'), join(root, 'node_modules/widgets'), 'dir');
    file('.env', `APP_KEY=${SENTINEL}\n`);
    file('.psx/manifest.ts', 'export const manifest = { routes: {}, operations: {}, modules: {} };\n');
    file(
        '.psx/client/pages/Private.psx.tsx',
        '\n\n\n\n\n\n\nexport default function Page() {\n    return null;\n}\n',
    );
    file('.psx/server/pages/Private.ts', 'export const $secret = { name: "secret" };\n');
}

async function make(
    entry: string,
    options: { sourcemap?: boolean; plugins?: Plugin[]; alias?: boolean } = {},
): Promise<void> {
    file('resources/entry.ts', entry);
    process.env.PSX_BUILD = '1';
    process.env.PSX_OUT = join(root, 'out');
    await build({
        configFile: false,
        root,
        logLevel: 'silent',
        build: { sourcemap: options.sourcemap ?? false },
        resolve: {
            alias: [
                { find: '@crabphp/psx/bindings', replacement: bindings },
                ...(options.alias
                    ? [
                          { find: '@res', replacement: join(root, 'resources') },
                          { find: '@cfg', replacement: join(root, 'config') },
                      ]
                    : []),
            ],
        },
        plugins: [...(options.plugins ?? []), ...psx({ entry: 'resources/entry.ts', react: false })],
    });
}

/** Every file a build wrote, as it is and with everything encoded in it decoded. */
function written(): { names: string[]; text: string } {
    const names: string[] = [];
    let text = '';
    const walk = (folder: string): void => {
        let entries: string[] = [];
        try {
            entries = readdirSync(folder);
        } catch {
            return;
        }
        for (const name of entries) {
            const path = join(folder, name);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            names.push(path.slice(root.length + 1));
            const content = readFileSync(path).toString('latin1');
            text += content;
            for (const match of content.matchAll(/base64,([A-Za-z0-9+/=]+)/g)) {
                text += Buffer.from(match[1]!, 'base64').toString('latin1');
            }
            try {
                text += decodeURIComponent(content);
            } catch {
                // Not percent-encoded as a whole.
            }
            text += content.replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
    };
    walk(join(root, 'out'));
    return { names, text };
}

async function refusedBuild(entry: string, options: Parameters<typeof make>[1] = {}): Promise<string> {
    const error = await make(entry, options).then(
        () => null,
        (thrown: unknown) => thrown as Error,
    );
    const out = written();
    // Whether it failed or not, nothing private was written.
    expect(out.text).not.toContain(SENTINEL);
    expect(out.text).not.toContain('<script lang="php">');
    expect(out.text).not.toContain('<?php');
    expect(error, `the build was not refused; it wrote ${out.names.join(', ')}`).toBeInstanceOf(Error);
    // And what is said of it quotes none of the file.
    expect(String(error!.message) + String(error!.stack)).not.toContain(SENTINEL);
    return error!.message;
}

beforeAll(() => {
    process.env.PSX_BUILD = '1';
});

afterEach(() => {
    if (root !== '') {
        rmSync(root, { recursive: true, force: true });
        root = '';
    }
});

afterAll(() => {
    process.env = saved;
});

describe('R1-B01: a file that holds PHP never becomes a file of the browser', () => {
    it.each([
        ['small enough to be written into the script', false],
        ['large enough to be a file of its own', true],
    ])('refuses new URL() of a .psx and of a .php, %s', async (_what, large) => {
        for (const name of ['./pages/Private.psx', './secret.php']) {
            application({ large });
            const message = await refusedBuild(`console.log(new URL('${name}', import.meta.url).href);`);
            expect(message).toMatch(/holds PHP/);
            rmSync(root, { recursive: true, force: true });
        }
        root = '';
    });

    it.each([
        ['with a query', `new URL('./pages/Private.psx?v=1', import.meta.url)`],
        ['with a fragment', `new URL('./pages/Private.psx#top', import.meta.url)`],
        ['in double quotes, spread over lines', `new URL(\n    "./secret.php",\n    import.meta.url,\n)`],
        ['in a template without holes', 'new URL(`./secret.php`, import.meta.url)'],
        ['by a path with a step back', `new URL('./pages/../secret.php', import.meta.url)`],
        ['from the root of the application', `new URL('/resources/secret.php', import.meta.url)`],
        ['by an alias', `new URL('@res/secret.php', import.meta.url)`],
        ['in a folder of the server', `new URL('../config/app.php', import.meta.url)`],
        ['the settings of the server', `new URL('../.env', import.meta.url)`],
        ['by a template with a hole for its name', 'new URL(`./pages/${name}.psx`, import.meta.url)'],
        ['by a template with a hole for all of it', 'new URL(`./pages/${name}`, import.meta.url)'],
    ])('refuses new URL() %s', async (_what, expression) => {
        application();
        await refusedBuild(`const name = 'Private';\nconsole.log(${expression}.href);`, { alias: true });
    });

    it('refuses a link that only looks like a picture', async () => {
        application();
        symlinkSync(join(root, 'resources/secret.php'), join(root, 'resources/disguise.png'));
        await refusedBuild(`console.log(new URL('./disguise.png', import.meta.url).href);`);
    });

    it.each([
        ['raw', `import text from './pages/Private.psx?raw'; console.log(text);`],
        ['url', `import address from './pages/Private.psx?url'; console.log(address);`],
        ['inline', `import address from './pages/Private.psx?inline'; console.log(address);`],
        ['a .php as raw', `import text from './secret.php?raw'; console.log(text);`],
        ['a .php as url', `import address from './secret.php?url'; console.log(address);`],
        ['a .php as a module', `import * as all from './secret.php'; console.log(all);`],
        ['an upper-case .PSX', `import text from './pages/Private.PSX?raw'; console.log(text);`],
        ['a glob as raw', `console.log(import.meta.glob('./pages/*.psx', { query: '?raw', eager: true }));`],
        ['a glob as url', `console.log(import.meta.glob('./*.php', { query: '?url', eager: true }));`],
        ['a lazy glob as raw', `console.log(import.meta.glob('./**/*.php', { query: '?raw' }));`],
        ['a dynamic import as raw', `import('./secret.php?raw').then(console.log);`],
    ])('refuses an import of %s', async (_what, entry) => {
        application();
        await refusedBuild(entry);
    });

    it.each([
        ['url()', `.a { background: url(./pages/Private.psx); }`],
        ['a quoted url()', `.a { background: url("./secret.php"); }`],
        ['image-set()', `.a { background: image-set("./secret.php" 1x); }`],
        ['a font source', `@font-face { font-family: x; src: url('./secret.php') format('woff2'); }`],
    ])('refuses a style sheet that names one by %s', async (_what, css) => {
        application({ large: true });
        file('resources/app.css', css);
        await refusedBuild(`import './app.css';`);
    });

    it.each([
        ['JSON of config/', `import secret from '../config/private.json'; console.log(secret);`],
        [
            'one name of that JSON',
            `import { credential } from '../config/private.json'; console.log(credential);`,
        ],
        [
            'the release’s private manifest',
            `import secret from '../build/psx/private-manifest.json'; console.log(secret);`,
        ],
        ['JSON of storage/', `import rows from '../storage/app/export.json'; console.log(rows);`],
        ['a picture of storage/', `import photo from '../storage/app/photo.png'; console.log(photo);`],
        ['a script of config/', `import { secret } from '../config/secrets'; console.log(secret);`],
        ['a script of app/', `import secret from '../app/Secrets.js'; console.log(secret);`],
        ['JSON of routes/', `import map from '../routes/map.json'; console.log(map);`],
        ['text of config/', `import keys from '../config/keys.txt?raw'; console.log(keys);`],
        ['SQL as an address', `import seed from '../database/seed.sql?url'; console.log(seed);`],
        ['the server’s settings as text', `import env from '../.env?raw'; console.log(env);`],
        ['JSON by a dynamic import', `import('../config/private.json').then(console.log);`],
        ['JSON by a glob', `console.log(import.meta.glob('../config/*.json', { eager: true }));`],
        ['JSON by a lazy glob', `console.log(import.meta.glob('../storage/**/*.json'));`],
        ['JSON by an alias', `import secret from '@cfg/private.json'; console.log(secret);`],
        ['JSON from the root', `import secret from '/config/private.json'; console.log(secret);`],
        [
            'what a PHP package keeps beside its scripts',
            `import note from '../vendor/acme/widgets/src/notes.json'; console.log(note);`,
        ],
        [
            'a script of a PHP package, though a package.json lies beside it',
            `import { widget } from '../vendor/acme/widgets/js/index.js'; console.log(widget);`,
        ],
        [
            'the same script by a link from node_modules',
            `import { widget } from 'widgets'; console.log(widget);`,
        ],
        ['JSON a module of the application passes on', `export * from './relay';`],
    ])('refuses %s, whatever it is imported as', async (_what, entry) => {
        application();
        file('resources/relay.ts', `export { default as passed } from '../config/private.json';\n`);
        const message = await refusedBuild(entry, { alias: true });
        expect(message).toMatch(/which is the server's|holds the settings of the server/);
    });

    it('refuses a private file a plugin loaded itself, by what the bundle was made of', async () => {
        application();
        // Loaded ahead of the boundary, as a plugin of the application's own might.
        const eager: Plugin = {
            name: 'loads-anything',
            enforce: 'pre',
            load(id) {
                return id.endsWith('private.json') ? JSON.stringify({ smuggled: SENTINEL }) : null;
            },
        };
        const message = await refusedBuild(
            `import secret from '../config/private.json'; console.log(secret);`,
            {
                plugins: [eager],
            },
        );
        expect(message).toMatch(/Nothing was built: .* was made of config\/private\.json/);
    });

    it('lets nothing private out by a way nobody refused: the bundle is looked through before it is written', async () => {
        for (const smuggle of [
            // A file emitted as it is.
            (source: string): Plugin => ({
                name: 'smuggle-file',
                buildStart() {
                    this.emitFile({ type: 'asset', fileName: 'assets/notes.txt', source });
                },
            }),
            // Written into a script, encoded.
            (source: string): Plugin => ({
                name: 'smuggle-inline',
                renderChunk(code) {
                    return `${code}\nconsole.log("data:text/plain;base64,${Buffer.from(source).toString('base64')}");`;
                },
            }),
            // Written into a script, percent-encoded.
            (source: string): Plugin => ({
                name: 'smuggle-percent',
                renderChunk(code) {
                    return `${code}\nconsole.log("data:text/plain,${encodeURIComponent(source)}");`;
                },
            }),
        ]) {
            application();
            const message = await refusedBuild(`console.log('entry');`, { plugins: [smuggle(php())] });
            expect(message).toMatch(/Nothing was built/);
            rmSync(root, { recursive: true, force: true });
        }
        root = '';
    });

    it('still builds what a browser may have: a component, its bindings, pictures, styles and maps', async () => {
        application();
        file('resources/big.png', Buffer.concat([png, Buffer.alloc(8000, 1)]));
        file(
            'resources/app.css',
            `.logo { background: url(./logo.png); }\n.big { background: url('./big.png'); }\n`,
        );
        await make(
            [
                `import './app.css';`,
                `import Page from './pages/Private.psx';`,
                `import { $secret } from './pages/Private.psx?server';`,
                `import logo from './logo.png';`,
                `import greeting from './data/public.json';`,
                `import { gadget } from 'gadgets';`,
                `console.log(greeting, gadget);`,
                `const name = 'logo';`,
                `console.log(Page, $secret, logo, new URL('./big.png', import.meta.url).href, new URL(\`./\${name}.png\`, import.meta.url).href);`,
            ].join('\n'),
            { sourcemap: true },
        );
        const out = written();
        expect(out.names.some(name => name.endsWith('.js'))).toBe(true);
        expect(out.names.some(name => name.endsWith('.map'))).toBe(true);
        expect(out.names.some(name => name.endsWith('.css'))).toBe(true);
        expect(out.names.some(name => /big-.*\.png$/.test(name))).toBe(true);
        expect(out.text).not.toContain(SENTINEL);
        expect(out.text).not.toContain('<script lang="php">');
        expect(out.text).not.toContain('<?php');
        expect(out.text).not.toContain('function load(): string');
        expect(out.text).toContain('a gadget of npm');
        expect(out.text).toContain('hello');
        // Every file it was made of is listed for the release's own check, and none of them is private.
        const inputs = JSON.parse(readFileSync(join(root, 'out/.vite/psx-inputs.json'), 'utf8')) as string[];
        expect(inputs).toEqual(
            expect.arrayContaining([
                'resources/entry.ts',
                'resources/data/public.json',
                'node_modules/gadgets/index.js',
                '.psx/client/pages/Private.psx.tsx',
                '.psx/server/pages/Private.ts',
                'resources/logo.png',
            ]),
        );
        expect(
            inputs.filter(input =>
                /^(?:config|build|storage|vendor|app|routes|database)\/|\.php$|\.psx$/.test(input),
            ),
        ).toEqual([]);
    });
});
