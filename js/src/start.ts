import { createElement, type ComponentType } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { installedManifest } from './bindings.js';
import { RequestFailure } from './protocol.js';
import { Runtime, setActiveRuntime } from './runtime.js';
import { plain } from './shapes.js';
import type { AuthTransitionState, Bootstrap, Manifest, QueryClient, Router } from './types.js';
import { App } from './view.js';

export interface StartOptions {
    root: HTMLElement;
    onError?: (
        error: Error,
        context: { kind: 'render' | 'protocol' | 'hydration'; build: string; requestId?: string },
    ) => void;
}

export interface PsxApp {
    readonly router: Router;
    readonly queries: QueryClient;
    /** Tells the application that who is signed in changed outside it. */
    authChanged(): Promise<AuthTransitionState>;
    dispose(): void;
}

/** Reads what the document was sent with. It is data in a script element no browser runs. */
export function readBootstrap(document: Document): Bootstrap {
    const element = document.getElementById('psx-bootstrap');
    let bootstrap: unknown = null;
    try {
        bootstrap = JSON.parse(element?.textContent ?? '');
    } catch {
        // Said below.
    }
    if (!plain(bootstrap) || !plain(bootstrap.envelope) || bootstrap.envelope.protocol !== 1) {
        throw new RequestFailure(
            'protocol',
            'This document was not written by PSX, or was cut short.',
            'rejected',
        );
    }
    return bootstrap as unknown as Bootstrap;
}

export function facade(runtime: Runtime): Router {
    const core = runtime.router;
    return {
        get location() {
            return core.getSnapshot().location;
        },
        get pending() {
            return core.getSnapshot().pending;
        },
        get navigationError() {
            return core.getSnapshot().navigationError;
        },
        navigate: core.navigate,
        revalidate: core.revalidate,
        prefetch: core.prefetch,
        block: core.block,
    };
}

/**
 * Starts the application in this document: reads what the document arrived with, loads the
 * modules of the page it shows, and mounts it. There is one application to a document.
 */
export function start(options: StartOptions, manifest: Manifest = installedManifest()): PsxApp {
    const bootstrap = readBootstrap(options.root.ownerDocument);
    // Read once. It is whoever was signed in then that it was written for: it is taken out of the
    // document, where it would outlast them and be read by a script as long as the document lives.
    options.root.ownerDocument.getElementById('psx-bootstrap')?.remove();
    const envelope = bootstrap.envelope;
    const runtime = new Runtime({
        manifest,
        build: envelope.kind === 'page' ? envelope.build : envelope.respondingBuild,
        limits: bootstrap.limits,
        development: bootstrap.development,
        onError: options.onError,
    });
    setActiveRuntime(runtime);
    let root: Root | null = null;
    let disposed = false;
    const element = createElement(App as ComponentType<{ runtime: Runtime }>, { runtime });
    const report = (kind: 'render' | 'hydration') => (error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), {
            kind,
            build: runtime.build,
        });
    };
    // The application is mounted once, the moment there is something of its own to show: the page
    // the document arrived with once its code is there, or before that whatever took its place, a
    // page a navigation showed or the wait while who is signed in is settled. Code that is slow
    // to arrive, or never does, holds up only its own page.
    const mount = (): void => {
        if (root !== null || disposed) {
            return;
        }
        watching();
        // The server's markup is of the page the document arrived with, written for whoever was
        // signed in then: it is kept where that page is the one shown, and thrown away otherwise.
        if (runtime.router.arrived && bootstrap.rendering === 'server' && options.root.firstChild !== null) {
            root = hydrateRoot(options.root, element, {
                onRecoverableError: report('hydration'),
                onUncaughtError: report('render'),
            });
            return;
        }
        options.root.replaceChildren();
        root = createRoot(options.root, { onUncaughtError: report('render') });
        root.render(element);
    };
    const watching = runtime.router.subscribe(() => {
        const snapshot = runtime.router.getSnapshot();
        if (snapshot.reconciling || snapshot.page !== null) {
            mount();
        }
    });
    runtime.router
        .install(envelope, location.pathname + location.search + location.hash)
        .then(mount)
        .catch((error: unknown) => {
            watching();
            const failure = error instanceof Error ? error : new Error(String(error));
            options.onError?.(failure, { kind: 'protocol', build: runtime.build });
            if (bootstrap.development || options.onError === undefined) {
                console.error('PSX could not start the page:', failure);
            }
            if (root !== null || disposed) {
                // Something else is shown already, and stays.
                return;
            }
            // The page cannot start: say so plainly, with nothing of the application around it.
            const notice = options.root.ownerDocument.createElement('p');
            notice.setAttribute('role', 'alert');
            notice.textContent =
                'This page could not start. Reload it; if it stays, the application was updated or is being updated.';
            options.root.replaceChildren(notice);
        });
    return {
        router: facade(runtime),
        queries: runtime.queries,
        authChanged: () => runtime.authChanged(),
        dispose: () => {
            disposed = true;
            watching();
            root?.unmount();
            runtime.dispose();
        },
    };
}
