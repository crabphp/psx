import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Runtime, setActiveRuntime } from './runtime.js';
import { listen, retire } from './socket.js';
import type { Manifest, PageEnvelope } from './types.js';
import { App } from './view.js';

/**
 * Renders a page to HTML from the envelope PHP made for it. The router and the query cache are
 * this render's alone; nothing is fetched, and what the browser starts from is the same envelope.
 */
export async function renderPage(
    manifest: Manifest,
    envelope: PageEnvelope,
    nonce: string | null = null,
): Promise<string> {
    if (typeof envelope !== 'object' || envelope === null || envelope.kind !== 'page') {
        throw new Error('The renderer is given a page.');
    }
    const runtime = new Runtime({ manifest, build: envelope.build, server: true });
    await runtime.router.install(envelope, envelope.route.href);
    // Rendering is one uninterrupted pass: nothing of another request's can be current during it.
    setActiveRuntime(runtime);
    try {
        const html = renderToString(createElement(App, { runtime }));
        return nonce === null ? html : vouched(html, nonce);
    } finally {
        setActiveRuntime(null);
        runtime.dispose();
    }
}

let inline: string | null | undefined;

/**
 * The one script React itself writes inline: what lets a form whose action is a function be sent
 * before the page has started, and be sent again once it has. It is asked of React once, so that
 * it is known by its whole text and by nothing less.
 */
function reactsOwn(): string | null {
    if (inline === undefined) {
        const html = renderToString(createElement('form', { action: () => undefined }));
        inline = /<script>[\s\S]*?<\/script>/.exec(html)?.[0] ?? null;
    }
    return inline;
}

/**
 * Gives React's own inline script the document's nonce, so that a policy that asks for one lets it
 * run. Nothing else is touched: markup a page wrote, a script among it, is as the page wrote it.
 */
function vouched(html: string, nonce: string): string {
    if (!/^[A-Za-z0-9+/_=-]{1,256}$/.test(nonce)) {
        throw new Error('The nonce is not one.');
    }
    const own = reactsOwn();
    return own === null
        ? html
        : html.split(own).join(`<script nonce="${nonce}">${own.slice('<script>'.length)}`);
}

function option(argv: readonly string[], name: string): string | undefined {
    const prefix = `--${name}=`;
    return argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}

/**
 * Runs the renderer of a release. The build's renderer bundle calls it; the application's server
 * starts that bundle with the socket to listen on and the release it must be.
 */
export function serve(manifest: Manifest, argv: readonly string[] = process.argv.slice(2)): void {
    const socket = option(argv, 'socket');
    const build = option(argv, 'build');
    if (socket === undefined || build === undefined) {
        throw new Error('The renderer is started with --socket=<path> and --build=<release>.');
    }
    const number = (name: string): number | undefined => {
        const value = Number(option(argv, name));
        return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    const server = listen({
        socket,
        build,
        render: (envelope, nonce) => renderPage(manifest, envelope as PageEnvelope, nonce),
        maxRequestBytes: number('max-request-bytes'),
        maxHtmlBytes: number('max-html-bytes'),
        maxInflight: number('max-inflight'),
        maxQueue: number('max-queue'),
        timeoutSeconds: number('timeout-seconds'),
    });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => {
            // Told again, it stops at once: the signal is listened for only the once.
            retire(server, () => process.exit(0));
        });
    }
}
