import react, { type Options as ReactOptions } from '@vitejs/plugin-react';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, PluginOption, ViteDevServer } from 'vite';
import {
    boundary,
    leak,
    privateSources,
    refused,
    scriptReferences,
    secret,
    styled,
    styleReferences,
    type Boundary,
} from './private.js';
import { listen } from './socket.js';

export interface PsxOptions {
    /** Where the .psx files are, from the application's folder. As "psx.resources" says; `resources` when unset. */
    resources?: string;
    /** Where the compiler writes what the browser may have. As "psx.client" says; `.psx` when unset. */
    client?: string;
    /** The script every document starts. As "psx.entry" says; `resources/entry.tsx` when unset. */
    entry?: string;
    /** Options of @vitejs/plugin-react, or false when the application adds that plugin itself. */
    react?: ReactOptions | false;
}

const RENDERER = 'virtual:psx-renderer';
/** Where a build lists every file it was made of, for `php cua psx:build` to judge before it publishes. */
const INPUTS = '.vite/psx-inputs.json';
const INSTALL =
    "import { manifest as __psxManifest } from '@psx/manifest'; import { install as __psxInstall } from '@crabphp/psx/bindings'; __psxInstall(__psxManifest);";

function inside(path: string, folder: string): boolean {
    return path === folder || path.startsWith(folder + sep);
}

function bare(id: string): string {
    const query = id.indexOf('?');
    return query === -1 ? id : id.slice(0, query);
}

/**
 * Builds the scripts of a PSX application. The PHP compiler has already split every .psx file:
 * this plugin gives Vite the TSX half where an import names the file, and the generated bindings
 * where one names its server. It never reads a .psx file, and refuses to serve one.
 */
export function psx(options: PsxOptions = {}): PluginOption[] {
    const environment = process.env;
    let root = process.cwd();
    let resources = '';
    let client = '';
    let entry = '';
    let building = false;
    let renderer = false;
    let devServer: ViteDevServer | null = null;
    let socket: Server | null = null;
    let limits: Boundary = boundary(root);
    const hot = (): string => join(client, 'hot');

    /** Where a compiled file stands for in the application: its .psx file, which only the folder is taken of. */
    const origin = (importer: string): string | null => {
        const staged = join(client, 'client');
        const file = bare(importer);
        return inside(file, staged) && file.endsWith('.psx.tsx')
            ? join(resources, relative(staged, file).slice(0, -'.tsx'.length))
            : null;
    };

    const plugin: Plugin = {
        name: 'crabphp-psx',
        enforce: 'pre',

        config(user, env) {
            root = resolve(user.root ?? process.cwd());
            resources = resolve(root, environment.PSX_RESOURCES ?? options.resources ?? 'resources');
            client = resolve(root, environment.PSX_CLIENT ?? options.client ?? '.psx');
            entry = resolve(root, environment.PSX_ENTRY ?? options.entry ?? 'resources/entry.tsx');
            limits = boundary(root);
            building = env.command === 'build';
            renderer = building && environment.PSX_SSR === '1';
            if (building && environment.PSX_BUILD !== '1') {
                throw new Error(
                    'The scripts of a PSX application are built with its PHP, as one release: run `php cua psx:build`, not `vite build`.',
                );
            }
            const out = environment.PSX_OUT;
            if (building && (out === undefined || !isAbsolute(out))) {
                throw new Error('`php cua psx:build` says where a build goes; this one was not told.');
            }
            const library = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
            return {
                // Nothing is copied into a build as it is: what is public is what an import reached.
                publicDir: false,
                base: building ? (environment.PSX_ASSETS ?? '/build/') : '/',
                resolve: {
                    alias: [{ find: /^@psx\//, replacement: `${client}/` }],
                    // The application's React is the only one, also for a package linked from a folder.
                    dedupe: ['react', 'react-dom'],
                },
                ssr: { noExternal: renderer ? true : ['@crabphp/psx'] },
                server: {
                    fs: {
                        allow: [root, library],
                        deny: [
                            '.env',
                            '.env.*',
                            '*.{crt,pem,key,sqlite,sqlite3}',
                            '**/.git/**',
                            '**/*.php',
                            '**/*.psx',
                            ...['build', 'storage', 'vendor', 'config', 'database', 'app', 'routes'].map(
                                folder => `${root}/${folder}/**`,
                            ),
                        ],
                    },
                    watch: {
                        ignored: ['build', 'storage', 'vendor', 'public'].map(
                            folder => `${root}/${folder}/**`,
                        ),
                    },
                },
                build: !building
                    ? {}
                    : renderer
                      ? {
                            ssr: true,
                            outDir: out,
                            emptyOutDir: true,
                            sourcemap: false,
                            copyPublicDir: false,
                            rollupOptions: {
                                input: { server: RENDERER },
                                output: { format: 'es', entryFileNames: 'server.mjs', codeSplitting: false },
                            },
                        }
                      : {
                            manifest: true,
                            outDir: out,
                            emptyOutDir: true,
                            // A map would carry no PHP, and is the application's to turn on.
                            sourcemap: user.build?.sourcemap ?? false,
                            rollupOptions: { input: entry },
                        },
            };
        },

        buildStart() {
            if (!existsSync(join(client, 'manifest.ts')) && (building || environment.PSX_DEV !== '1')) {
                throw new Error(
                    `${relative(root, client) || client} has no compiled pages. \`php cua dev\` and \`php cua psx:build\` compile them before Vite runs; start Vite through one of them.`,
                );
            }
        },

        async resolveId(source, importer, extra) {
            if (source === RENDERER) {
                return `\0${RENDERER}`;
            }
            const [path = '', query = ''] = source.split('?');
            const from = importer === undefined ? null : origin(importer);
            if (/\.psx$/i.test(path) && !path.endsWith('.psx')) {
                throw new Error(`"${source}" holds PHP, which no script is given.`);
            }
            if (path.endsWith('.psx')) {
                if (query !== '' && query !== 'server') {
                    throw new Error(
                        `"${source}" asks for a .psx file as "${query}". A .psx file holds PHP and is never given to a script: import its component, or its bindings with "?server".`,
                    );
                }
                let file: string;
                if (path.startsWith('.')) {
                    if (importer === undefined) {
                        return null;
                    }
                    file = resolve(dirname(from ?? bare(importer)), path);
                } else if (isAbsolute(path)) {
                    file = inside(path, root) ? path : join(root, path);
                } else {
                    const found = await this.resolve(path, importer, { ...extra, skipSelf: true });
                    if (found === null) {
                        return null;
                    }
                    file = bare(found.id);
                }
                const staged = join(client, 'client');
                const module = inside(file, staged)
                    ? relative(staged, file)
                    : inside(file, resources)
                      ? relative(resources, file)
                      : null;
                if (module === null) {
                    throw new Error(
                        `"${source}" is outside ${relative(root, resources)}, where the .psx files of the application are.`,
                    );
                }
                const id = module.slice(0, -'.psx'.length).split(sep).join('/');
                const target =
                    query === 'server' ? join(client, 'server', `${id}.ts`) : join(staged, `${id}.psx.tsx`);
                if (!existsSync(target)) {
                    throw new Error(
                        query === 'server'
                            ? `${relative(root, join(resources, module))} has no bindings to import: it is not declared as a page, a layout or a service, or it was not compiled yet.`
                            : `${relative(root, join(resources, module))} was not compiled. Is it there, and is \`php cua dev\` running?`,
                    );
                }
                return target;
            }
            if (from !== null && path.startsWith('.')) {
                // What a compiled file imports beside itself is beside the .psx file it came from.
                const found = await this.resolve(source, from, { ...extra, skipSelf: true });
                if (found !== null) {
                    return found;
                }
            }
            return null;
        },

        load(id) {
            if (id === `\0${RENDERER}`) {
                return [
                    "import { manifest } from '@psx/manifest';",
                    "import { install } from '@crabphp/psx/bindings';",
                    "import { serve } from '@crabphp/psx/ssr';",
                    'install(manifest);',
                    'serve(manifest);',
                ].join('\n');
            }
            const file = bare(id);
            if (id.startsWith('\0') || !isAbsolute(file) || inside(file, join(client, 'client'))) {
                // Made up by a plugin, or the half of a .psx file the compiler wrote for the browser.
                return null;
            }
            const why = secret(file, limits);
            if (why !== null) {
                // By where it is and what it is, whatever it is imported as: a module, JSON, text, an
                // address. Before it is read, so that neither its content nor a frame of it reaches a
                // script or an error overlay.
                throw new Error(`${relative(root, file)} ${why}, and no script is given it.`);
            }
            return null;
        },

        async transform(code, id) {
            // A file named as a file, by `new URL(..., import.meta.url)` or by a style sheet's url(), is
            // read by Vite itself and asks no plugin. It is refused here, before Vite sees the reference.
            const file = bare(id);
            if (!id.startsWith('\0') && isAbsolute(file)) {
                const from = origin(id);
                const bases = from === null ? [dirname(file)] : [dirname(file), dirname(from)];
                const references = styled(id)
                    ? styleReferences(code, bases, limits)
                    : scriptReferences(code, bases, limits);
                for (const reference of references) {
                    // A name that is no path, such as an alias, is whatever it resolves to.
                    if (!/^[./]/.test(reference.text) && !reference.text.includes('${')) {
                        const found = await this.resolve(reference.text.split(/[?#]/, 1)[0]!, id, {
                            skipSelf: true,
                        });
                        if (found !== null && !found.external) {
                            reference.files.push(bare(found.id));
                        }
                    }
                }
                const no = refused(references, limits);
                if (no !== null) {
                    throw new Error(
                        `${relative(root, file)} names "${no.text}" as a file for the browser. ${relative(root, no.file)} ${no.why}: it is never given to a browser. Import a .psx file's component, or its bindings with "?server".`,
                    );
                }
            }
            // The entry is where the build's manifest meets the runtime, before anything of the entry runs.
            return file === entry ? { code: `${INSTALL} ${code}`, map: null } : null;
        },

        generateBundle: {
            order: 'post',
            handler(_options, bundle) {
                // Whatever way a file took into the bundle, nothing private leaves in it: every file about
                // to be written is compared with the application's PHP, as it is and decoded.
                const sources = privateSources(limits, [resources]);
                // What the bundle was made of, by file: a private file is refused for being in it,
                // whatever became of its content on the way.
                const inputs = new Set<string>();
                for (const [name, output] of Object.entries(bundle)) {
                    const made =
                        output.type === 'chunk'
                            ? Object.keys(output.modules)
                            : [...(output.originalFileNames ?? [])].map(original => resolve(root, original));
                    for (const id of made) {
                        const file = bare(id);
                        if (id.startsWith('\0') || !isAbsolute(file)) {
                            continue;
                        }
                        inputs.add(file);
                        if (inside(file, join(client, 'client'))) {
                            continue;
                        }
                        const why = secret(file, limits);
                        if (why !== null) {
                            throw new Error(
                                `Nothing was built: ${name} was made of ${relative(root, file)}, which ${why}. PHP and the server's files are never given to a browser.`,
                            );
                        }
                    }
                }
                // For the release's own check, which trusts no plugin's word: every file that went in.
                this.emitFile({
                    type: 'asset',
                    fileName: INPUTS,
                    source: JSON.stringify(
                        [...inputs].map(file => relative(root, file).split(sep).join('/')).sort(),
                    ),
                });
                for (const [name, output] of Object.entries(bundle)) {
                    if (name === INPUTS) {
                        continue;
                    }
                    const named =
                        output.type === 'asset'
                            ? [...(output.originalFileNames ?? [])].find(
                                  original => secret(resolve(root, original), limits) !== null,
                              )
                            : undefined;
                    const found =
                        named !== undefined
                            ? `${name} was made of ${named}`
                            : leak(name, output.type === 'asset' ? output.source : output.code, sources);
                    if (found !== null) {
                        throw new Error(
                            `Nothing was built: ${found}. PHP and the server's files are never given to a browser.`,
                        );
                    }
                    if (output.type === 'chunk' && output.map != null) {
                        const mapped = leak(`${name}.map`, JSON.stringify(output.map), sources);
                        if (mapped !== null) {
                            throw new Error(`Nothing was built: ${mapped}.`);
                        }
                    }
                }
            },
        },

        configureServer(server) {
            devServer = server;
            server.middlewares.use((request, response, next) => {
                const path = (request.url ?? '').split('?')[0] ?? '';
                let decoded = path;
                try {
                    decoded = decodeURIComponent(path);
                } catch {
                    // Refused below as it is.
                }
                if (/\.(psx|php)$/i.test(decoded) || /%/.test(decoded)) {
                    response.statusCode = 403;
                    response.end('PHP is not served.');
                    return;
                }
                next();
            });
            const said = (): void => {
                const address = server.httpServer?.address();
                if (address === null || address === undefined || typeof address === 'string') {
                    return;
                }
                const configured = server.config.server.origin;
                const local = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
                const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
                const url = configured ?? local ?? `http://${host}:${address.port}`;
                if (configured === undefined) {
                    // What a script imports as a file is asked of Vite, not of the PHP server the document came from.
                    server.config.server.origin = url;
                }
                mkdirSync(client, { recursive: true });
                writeFileSync(hot(), `${url}\n`);
            };
            const listening = server.listen.bind(server);
            server.listen = async (...parameters) => {
                const result = await listening(...parameters);
                said();
                return result;
            };
            // When PHP starts another server, the pages open in a browser load again from it.
            const generation = join(client, 'generation');
            server.watcher.add(generation);
            const reload = (file: string): void => {
                if (file === generation) {
                    server.hot.send({ type: 'full-reload', path: '*' });
                }
            };
            server.watcher.on('change', reload);
            server.watcher.on('add', reload);
            const gone = (): void => {
                rmSync(hot(), { force: true });
                socket?.close();
                socket = null;
            };
            server.httpServer?.once('close', gone);
            process.once('exit', gone);
            for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
                process.once(signal, () => {
                    gone();
                    process.exit(0);
                });
            }
            const path = environment.PSX_SSR_SOCKET;
            if (path !== undefined && path !== '') {
                socket = listen({
                    socket: path,
                    build: null,
                    timeoutSeconds: 15,
                    render: async (envelope, nonce) => {
                        // Loaded through Vite each time: a page is rendered with the code it will hydrate with.
                        const built = await server.ssrLoadModule('@psx/manifest');
                        const bindings = await server.ssrLoadModule('@crabphp/psx/bindings');
                        const rendering = await server.ssrLoadModule('@crabphp/psx/ssr');
                        bindings.install(built.manifest);
                        return rendering.renderPage(built.manifest, envelope, nonce);
                    },
                    log: line => server.config.logger.error(line),
                });
            }
        },

        closeBundle() {
            if (devServer === null) {
                socket?.close();
            }
        },
    };

    return options.react === false ? [plugin] : [plugin, react(options.react)];
}
export default psx;
