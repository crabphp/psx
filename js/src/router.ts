import { exchange, readProblem, RequestFailure } from './protocol.js';
import { readAuth, type Runtime } from './runtime.js';
import { mismatch, plain } from './shapes.js';
import type {
    AuthSnapshot,
    AuthTransitionState,
    JsonValue,
    NavigationBlocker,
    NavigationFailure,
    NavigationIntent,
    NavigationOptions,
    NavigationOrigin,
    NavigationResult,
    PageModule,
    PublicProblem,
    RouteScope,
    RouteTarget,
    Segment,
    Shape,
    WireHead,
    WireNode,
} from './types.js';

export interface PageNode {
    readonly mount: string;
    readonly module: string;
    readonly key: string;
    readonly data: unknown;
    readonly scope: RouteScope;
    readonly exports: PageModule;
}

export interface PageState {
    readonly routeId: string | null;
    readonly href: string;
    readonly nodes: readonly PageNode[];
    /** Why the page could not be loaded; the nodes are then the layouts that had loaded before it. */
    readonly problem: PublicProblem | null;
    /** The module of the loader that failed, whose RouteError shows the problem. */
    readonly failed: PageModule | null;
    readonly head: WireHead;
    readonly tags: readonly string[];
    readonly origin: NavigationOrigin;
    /** Counts what was committed: a navigation raises it, a refresh of the same page does not. */
    readonly commit: number;
    readonly scroll: 'top' | 'hash' | 'restore' | 'none';
}

export interface RouterSnapshot {
    readonly location: { readonly href: string; readonly entryKey: string; readonly state: JsonValue | null };
    readonly pending: null | { readonly href: string };
    readonly navigationError: NavigationFailure | null;
    readonly page: PageState | null;
    /** True while who is signed in changed and the page is being loaded again as them. */
    readonly reconciling: boolean;
    /** True when that could not be done here: only a document navigation shows the right page. */
    readonly documentRequired: boolean;
}

type Loaded =
    | {
          type: 'page';
          routeId: string;
          href: string;
          nodes: WireNode[];
          exports: PageModule[];
          head: WireHead;
          tags: string[];
          auth: AuthSnapshot | null;
      }
    | {
          type: 'problem';
          problem: PublicProblem;
          routeId: string | null;
          nodes: WireNode[];
          exports: PageModule[];
          failed: PageModule | null;
          head: WireHead;
          tags: string[];
          auth: AuthSnapshot | null;
      }
    | { type: 'redirect'; href: string; mode: 'internal' | 'document'; replace: boolean };

interface Matcher {
    name: string;
    expression: RegExp;
    weight: number;
}

const emptyHead: WireHead = { title: null, meta: {}, links: {} };

class Blocker implements NavigationBlocker {
    held: {
        intent: NavigationIntent;
        generation: number;
        epoch: number;
        release: () => Promise<NavigationResult>;
    } | null = null;

    /** A newer intent was made: what was held of an older one is nobody's to let through. */
    overtaken(generation: number): void {
        if (this.held !== null && this.held.generation !== generation) {
            this.held = null;
            this.emit();
        }
    }
    disposed = false;
    private listeners = new Set<() => void>();

    constructor(
        private readonly router: RouterCore,
        readonly test: (next: NavigationIntent) => boolean,
    ) {}

    getSnapshot = (): NavigationIntent | null => this.held?.intent ?? null;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    hold(held: NonNullable<Blocker['held']>): void {
        this.held = held;
        this.emit();
    }

    proceed = (): Promise<NavigationResult> => {
        const held = this.held;
        if (held === null) {
            return Promise.resolve({ status: 'superseded' });
        }
        this.held = null;
        this.emit();
        // Only the attempt that was held is let through, and only while it is still the latest one.
        if (!this.router.latest(held.generation, held.epoch)) {
            return Promise.resolve({ status: 'superseded' });
        }
        return held.release();
    };

    reset = (): void => {
        if (this.held !== null) {
            this.router.abandon(this.held.generation);
            this.held = null;
            this.emit();
        }
    };

    dispose = (): void => {
        this.reset();
        this.disposed = true;
        this.router.unblock(this);
    };

    private emit(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

/**
 * The page the document shows and how it changes. Every navigation is numbered: one that a newer
 * one overtook never commits, whatever order their answers arrive in. The current page stays
 * mounted until the next is whole: its data, its modules, its title.
 */
export class RouterCore {
    private snapshot: RouterSnapshot;
    private listeners = new Set<() => void>();
    /** True once the page the document arrived with is the one shown, by its own code. */
    arrived = false;
    /** The document's own page as the server rendered it, until another page is on screen. */
    private document: RouterSnapshot | null = null;
    private matchers: Matcher[];
    /** Numbers every intent to show another page. An origin is of the intent that was the latest when it was made. */
    private generation = 0;
    /** Numbers every refresh of the page shown, and says which was the last one taken. */
    private refreshes = 0;
    private refreshed = 0;
    /** A step through history whose page is still being asked for: the address bar is already there. */
    private traversal: { href: string; key: string; index: number; state: JsonValue | null } | null = null;
    private settling: Promise<AuthTransitionState> | null = null;
    private disposed = false;
    private commits = 0;
    private index = 0;
    private scrolls = new Map<string, [number, number]>();
    private blockers = new Set<Blocker>();
    private prefetched = new Map<string, { at: number; epoch: number; promise: Promise<Loaded> }>();
    private controller: AbortController | null = null;
    /**
     * The entry a step this router asked of the browser, to put the address back, will arrive at.
     * That arrival is the router's own and is not a navigation; any other is.
     */
    private expectPop: string | null = null;
    private passPop = false;
    private attached = false;
    private focusNext = false;

    constructor(private readonly runtime: Runtime) {
        this.matchers = Object.entries(runtime.manifest.routes)
            .map(([name, route]) => ({
                name,
                expression: new RegExp(`^${route.path.map(pattern).join('')}$`),
                weight: route.path.reduce(
                    (sum, segment) => sum + ('text' in segment ? segment.text.length : 0),
                    0,
                ),
            }))
            .sort((a, b) => b.weight - a.weight);
        this.snapshot = {
            location: { href: '/', entryKey: 'initial', state: null },
            pending: null,
            navigationError: null,
            page: null,
            reconciling: false,
            documentRequired: false,
        };
    }

    getSnapshot = (): RouterSnapshot => this.snapshot;

    /**
     * What the server rendered the document from, for as long as its markup may still be taken
     * over: the document's own page, with nothing on its way and nothing failed. A navigation that
     * began before the page started, or failed by then, is shown once the markup is the
     * application's, as any change is, and never as a difference from what the server wrote.
     */
    getServerSnapshot = (): RouterSnapshot => this.document ?? this.snapshot;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    /** The name of the page an address of this site is, as far as the browser can tell; null for none. */
    match(pathname: string): string | null {
        let path = pathname;
        try {
            path = decodeURI(pathname);
        } catch {
            // An address that does not decode is matched as it was written.
        }
        for (const matcher of this.matchers) {
            if (matcher.expression.test(path) || matcher.expression.test(pathname)) {
                return matcher.name;
            }
        }
        return null;
    }

    /**
     * Shows the page the document arrived with, without asking for it again; true when it is that
     * page that is shown.
     *
     * The document's place in history, the listening for steps through it, and who the document
     * says is signed in are taken at once. The page itself waits for its code, and that can take
     * long: by then a navigation may have shown another page, who is signed in may have come into
     * question, or the application may have been closed. What the document arrived with is shown
     * only where nothing has taken its place: at its own address, with no page there yet, as the
     * person it was written for. Otherwise it is dropped, whether its code arrived or failed to,
     * and what is known of who is signed in is never set back to it.
     */
    async install(envelope: unknown, href: string): Promise<boolean> {
        let entryKey = newKey();
        let state: JsonValue | null = null;
        if (!this.runtime.server) {
            const existing = plain(history.state) ? history.state : {};
            const own = plain(existing.psx) ? existing.psx : null;
            if (own !== null && typeof own.key === 'string' && typeof own.index === 'number') {
                // A reload or a return to an entry this application made: it keeps its place.
                entryKey = own.key;
                this.index = own.index;
                state = (own.state as JsonValue) ?? null;
            } else {
                history.replaceState(
                    { ...existing, psx: { key: entryKey, index: this.index, state: null } },
                    '',
                    location.href,
                );
            }
            try {
                history.scrollRestoration = 'manual';
            } catch {
                // Not every browser lets it be set; scroll is then the browser's.
            }
            this.attach();
        }
        this.snapshot = { ...this.snapshot, location: { href, entryKey, state } };
        if (plain(envelope) && envelope.kind === 'page') {
            const auth = readAuth(envelope.auth);
            if (auth !== null) {
                // The document is the browser's own account of who it is, as it was sent: known
                // from the start, so that whatever is answered meanwhile is held to it.
                this.runtime.auth = auth;
            }
        }
        const generation = this.generation;
        const epoch = this.runtime.epoch;
        let loaded: Loaded;
        try {
            loaded = await this.read(envelope, href);
        } catch (error) {
            if (this.disposed || generation !== this.generation || epoch !== this.runtime.epoch) {
                // Something newer is under way or done, and decides what is shown: that the
                // document's own page could not be read is said, and stops nothing.
                if (!this.disposed && error instanceof Error) {
                    this.runtime.onError?.(error, { kind: 'protocol', build: this.runtime.build });
                }
                return false;
            }
            throw error;
        }
        const place = this.snapshot.location;
        const [here, document] = [new URL(place.href, 'http://psx'), new URL(href, 'http://psx')];
        if (
            this.disposed ||
            epoch !== this.runtime.epoch ||
            this.snapshot.reconciling ||
            this.snapshot.page !== null ||
            here.pathname !== document.pathname ||
            here.search !== document.search
        ) {
            return false;
        }
        if (loaded.type === 'redirect') {
            throw new RequestFailure('protocol', 'The document cannot be read.', 'rejected');
        }
        if (
            loaded.type === 'page' &&
            loaded.auth !== null &&
            this.runtime.standing(loaded.auth) !== 'current'
        ) {
            // An answer since has said more of who is signed in than the document knew: the page
            // is read again as whoever that is, and the document's own is not shown.
            this.runtime.doubt(loaded.auth);
            return false;
        }
        this.arrived = true;
        const page = this.page(
            loaded,
            href,
            {
                entryKey: place.entryKey,
                epoch,
                // A navigation still on its way is leaving this page, as it would one shown before it.
                intent: this.snapshot.pending === null ? this.generation : generation,
            },
            // A document opened at a place in its page starts there, once the page is on screen.
            !this.runtime.server && location.hash !== '' ? 'hash' : 'none',
        );
        // As the server had it: before anyone is told, so that whoever takes its markup over has it.
        this.document = { ...this.snapshot, page, pending: null, navigationError: null };
        this.set({ page });
        return true;
    }

    navigate = async (to: RouteTarget, options: NavigationOptions = {}): Promise<NavigationResult> => {
        const url = this.resolve(to);
        // Before anything else, wherever it goes: a page that is no longer the one shown moves nothing.
        if (options.ifCurrent !== undefined && !this.current(options.ifCurrent)) {
            return { status: 'superseded' };
        }
        // Who is signed in is being settled: the navigation is held until it is, and nothing is
        // shown under an address meanwhile. When it cannot be settled here, the document goes there.
        while (this.snapshot.reconciling && !this.snapshot.documentRequired && !this.disposed) {
            await this.settling?.catch(() => undefined);
        }
        if (this.disposed) {
            return { status: 'superseded' };
        }
        return this.begin(url, options, this.snapshot.reconciling);
    };

    revalidate = async (): Promise<void> => {
        const page = this.snapshot.page;
        if (page === null || this.runtime.server || this.snapshot.reconciling) {
            return;
        }
        // Each refresh is numbered: of two that overlap, the one asked for later is the one kept.
        const ticket = ++this.refreshes;
        const commit = page.commit;
        const epoch = this.runtime.epoch;
        const href = this.snapshot.location.href;
        const shown = (): boolean =>
            this.snapshot.page?.commit === commit &&
            epoch === this.runtime.epoch &&
            !this.snapshot.reconciling;
        const retry = (): Promise<NavigationResult> =>
            this.revalidate().then(() => ({ status: 'committed', href }) as NavigationResult);
        try {
            const loaded = await this.load(href, undefined, true);
            if (!shown() || ticket <= this.refreshed) {
                // The page it was asked for is no longer the one shown, or a later refresh was taken already.
                return;
            }
            if (loaded.type === 'redirect') {
                if (ticket === this.refreshes) {
                    await this.follow(loaded);
                }
                return;
            }
            const admitted = this.admit(loaded);
            if (admitted === 'barred') {
                return;
            }
            if (admitted === 'stale') {
                throw new RequestFailure('auth', outdated, 'rejected');
            }
            this.refreshed = ticket;
            this.set({
                page: this.page(
                    loaded,
                    this.snapshot.location.href,
                    this.snapshot.page!.origin,
                    'none',
                    commit,
                ),
                // Only the latest refresh says the page is up to date.
                ...(ticket === this.refreshes ? { navigationError: null } : {}),
            });
            this.head(this.snapshot.page!.head);
        } catch (error) {
            if (!(error instanceof RequestFailure)) {
                throw error;
            }
            if (
                !shown() ||
                ticket !== this.refreshes ||
                ticket <= this.refreshed ||
                error.kind === 'aborted'
            ) {
                // Of another page, or of a refresh a later one has overtaken: it says nothing of now.
                return;
            }
            // What is shown stays shown; the failure says it may be out of date.
            this.fail(href, error, retry);
        }
    };

    prefetch = async (to: RouteTarget): Promise<void> => {
        const url = this.resolve(to);
        if (url.origin !== location.origin || this.match(url.pathname) === null) {
            return;
        }
        const href = url.pathname + url.search;
        const known = this.prefetched.get(href);
        if (known !== undefined && this.fresh(known)) {
            return;
        }
        const promise = this.load(href, undefined, true);
        this.prefetched.set(href, { at: Date.now(), epoch: this.runtime.epoch, promise });
        if (this.prefetched.size > 20) {
            this.prefetched.delete(this.prefetched.keys().next().value!);
        }
        await promise.catch(() => {
            // Only itself: one read ahead for the same address since is not this one's to take away.
            if (this.prefetched.get(href)?.promise === promise) {
                this.prefetched.delete(href);
            }
        });
    };

    /**
     * Lets go of every page read ahead. A write was sent: what a page was before it, or while it
     * was on its way, is not shown as what the page is now. The next navigation asks.
     */
    forget(): void {
        this.prefetched.clear();
    }

    block = (test: (next: NavigationIntent) => boolean): NavigationBlocker => {
        const blocker = new Blocker(this, test);
        this.blockers.add(blocker);
        return blocker;
    };

    unblock(blocker: Blocker): void {
        this.blockers.delete(blocker);
    }

    latest(generation: number, epoch: number): boolean {
        return generation === this.generation && epoch === this.runtime.epoch;
    }

    /** A held attempt was given up: nothing of it may commit later, and the page shown may start anew. */
    abandon(generation: number): void {
        if (generation === this.generation) {
            this.generation++;
            this.republish();
        }
    }

    /**
     * Whether an origin is still the page shown, with nothing newer on its way: the same entry,
     * the same person signed in, and no intent made since the one the origin is of. An address
     * replaced in its entry, an attempt that is held, and one that failed all leave it behind.
     */
    current(origin: NavigationOrigin): boolean {
        return (
            origin.entryKey === this.snapshot.location.entryKey &&
            origin.epoch === this.runtime.epoch &&
            origin.intent === this.generation &&
            this.snapshot.pending === null &&
            !this.snapshot.reconciling
        );
    }

    /** True from when who is signed in changed until the page is shown as them: nothing is written meanwhile. */
    barred(): boolean {
        return this.snapshot.reconciling;
    }

    /** The settling of who is signed in that is under way or was last done; null when there was none. */
    reconciliation(): Promise<AuthTransitionState> | null {
        return this.settling;
    }

    /** What an action said changed is what this page shows: load it again. */
    invalidated(tags: readonly string[]): void {
        const page = this.snapshot.page;
        if (page !== null && tags.some(tag => page.tags.includes(tag))) {
            void this.revalidate().catch(() => undefined);
        }
    }

    /**
     * Loads the page again as whoever is signed in now, showing nothing of before until it has.
     * Until then, and for good when it cannot be done here, the barrier stands: nothing is written,
     * a navigation waits, and nothing that was asked for before is shown.
     */
    reconcile(): Promise<AuthTransitionState> {
        const settling: Promise<AuthTransitionState> = this.settle(() => settling);
        this.settling = settling;
        return settling;
    }

    private async settle(self: () => Promise<AuthTransitionState>): Promise<AuthTransitionState> {
        const epoch = this.runtime.epoch;
        const known = this.runtime.auth;
        const generation = this.intend();
        this.prefetched.clear();
        // A step through history that was under way had moved the address bar already: that is where the browser is.
        const traversal = this.traversal;
        this.traversal = null;
        if (traversal !== null) {
            this.index = traversal.index;
        }
        const place =
            traversal === null
                ? this.snapshot.location
                : { href: traversal.href, entryKey: traversal.key, state: traversal.state };
        this.set({
            location: place,
            reconciling: true,
            documentRequired: false,
            pending: null,
            navigationError: null,
            // What was shown was someone else's, for all this page knows.
            page: null,
        });
        this.document = null;
        // Its title and its own head tags were that person's as well: a tab's name is read too.
        this.head({ title: null, meta: {}, links: {} });
        const href = place.href;
        const mine = (): boolean =>
            epoch === this.runtime.epoch &&
            generation === this.generation &&
            href === this.snapshot.location.href;
        const required = (): AuthTransitionState => {
            if (mine()) {
                this.set({ documentRequired: true });
            }
            return { status: 'document-required', origin: null };
        };
        try {
            const controller = new AbortController();
            const reading = this.load(href, controller.signal, true);
            // Should the time run out first, what the read comes to is nobody's to hear.
            reading.catch(() => undefined);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const late = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(
                        new RequestFailure('network', 'The page took too long to load again.', 'rejected'),
                    );
                }, this.runtime.limits.authReconcileSeconds * 1000);
            });
            let loaded: Loaded;
            try {
                loaded = await Promise.race([reading, late]);
            } finally {
                clearTimeout(timer);
            }
            if (epoch !== this.runtime.epoch) {
                // It changed again meanwhile: the newer change's own settling decides, for both.
                const newer = this.settling;
                return newer === null || newer === self()
                    ? { status: 'document-required', origin: null }
                    : newer;
            }
            if (!mine() || loaded.type !== 'page') {
                // A redirect to sign in, or a refusal: nothing here is this person's to show.
                return required();
            }
            if (loaded.auth === null) {
                if (known !== null) {
                    // The application says who is signed in on every page, and this one does not: it proves nothing.
                    return required();
                }
            } else if (known !== null && loaded.auth.context === known.context) {
                const standing = this.runtime.standing(loaded.auth);
                if (
                    standing === 'stale' ||
                    (standing === 'doubtful' && this.older(loaded.auth.revision, known.revision))
                ) {
                    // Older than what was already known: it was answered as someone the browser no longer is.
                    return required();
                }
            }
            this.runtime.auth = loaded.auth;
            const origin = { entryKey: this.snapshot.location.entryKey, epoch, intent: generation };
            this.set({ reconciling: false, page: this.page(loaded, href, origin, 'none') });
            this.head(this.snapshot.page!.head);
            return { status: 'reconciled', origin };
        } catch (error) {
            if (!(error instanceof RequestFailure)) {
                throw error;
            }
            if (epoch !== this.runtime.epoch) {
                const newer = this.settling;
                return newer === null || newer === self()
                    ? { status: 'document-required', origin: null }
                    : newer;
            }
            return required();
        }
    }

    private older(revision: string, than: string): boolean {
        try {
            return BigInt(revision) < BigInt(than);
        } catch {
            return true;
        }
    }

    /** Called by the view once what was committed is on screen: place the scroll, move the focus. */
    committed(page: PageState): void {
        if (this.runtime.server) {
            return;
        }
        if (this.document !== null && this.document.page?.commit !== page.commit) {
            // Another page is on screen: the server's markup is no longer there to take over.
            this.document = null;
        }
        if (page.scroll === 'top') {
            window.scrollTo(0, 0);
        } else if (page.scroll === 'hash') {
            this.toHash();
        } else if (page.scroll === 'restore') {
            const [x, y] = this.scrolls.get(page.origin.entryKey) ?? [0, 0];
            window.scrollTo(x, y);
        }
        if (this.focusNext) {
            this.focusNext = false;
            const target =
                document.querySelector<HTMLElement>('[data-psx-focus]') ??
                document.querySelector<HTMLElement>('main');
            if (target !== null) {
                if (!target.hasAttribute('tabindex')) {
                    target.setAttribute('tabindex', '-1');
                }
                target.focus({ preventScroll: true });
            }
            let announcer = document.getElementById('psx-announcer');
            if (announcer === null) {
                announcer = document.createElement('div');
                announcer.id = 'psx-announcer';
                announcer.setAttribute('aria-live', 'polite');
                announcer.setAttribute('role', 'status');
                announcer.style.cssText =
                    'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
                document.body.appendChild(announcer);
            }
            announcer.textContent = document.title;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.generation++;
        this.controller?.abort();
        if (this.attached) {
            window.removeEventListener('popstate', this.popped);
            window.removeEventListener('pageshow', this.shown);
            this.attached = false;
        }
        this.listeners.clear();
    }

    private attach(): void {
        if (!this.attached) {
            window.addEventListener('popstate', this.popped);
            window.addEventListener('pageshow', this.shown);
            this.attached = true;
        }
    }

    private resolve(to: RouteTarget): URL {
        const href = typeof to === 'string' ? to : to.href;
        const url = new URL(href, location.href);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new TypeError(`A page is navigated to an http(s) address, not "${url.protocol}".`);
        }
        return url;
    }

    private leave(href: string, replace = false): void {
        this.runtime.leave(href, replace);
    }

    /** The entry the browser is at, as this application wrote it; null for one it did not write. */
    private physical(): { key: string; index: number } | null {
        const own = plain(history.state) && plain(history.state.psx) ? history.state.psx : null;
        return own !== null && typeof own.key === 'string' && typeof own.index === 'number'
            ? { key: own.key, index: own.index }
            : null;
    }

    /**
     * Puts the address bar back at the entry of the page shown, where a step through history that
     * came to nothing left it elsewhere: one that was overtaken by an attempt which was then held
     * or failed. The page and its address are never left apart.
     */
    private realign(): void {
        this.traversal = null;
        const shown = this.snapshot.location.entryKey;
        const own = this.physical();
        if (own === null || own.key === shown) {
            this.expectPop = null;
            return;
        }
        if (this.expectPop === shown) {
            // Already on its way back.
            return;
        }
        const delta = this.index - own.index;
        if (delta !== 0) {
            this.expectPop = shown;
            history.go(delta);
        }
    }

    /**
     * A new intent to show another page. Whatever was on its way or was held before it is no
     * longer the latest, and every origin made before it is of a page that is being left.
     */
    private intend(): number {
        this.controller?.abort();
        this.controller = null;
        const generation = ++this.generation;
        for (const blocker of this.blockers) {
            blocker.overtaken(generation);
        }
        if (this.snapshot.pending !== null) {
            this.set({ pending: null });
        }
        return generation;
    }

    /**
     * Gives the page shown, which stays, an origin of now. Its components render again with scopes
     * that may start a navigation; what was made before keeps the origin it had, which is stale.
     */
    private republish(): void {
        const page = this.snapshot.page;
        if (page === null || this.snapshot.reconciling || this.disposed) {
            return;
        }
        const origin: NavigationOrigin = {
            entryKey: this.snapshot.location.entryKey,
            epoch: this.runtime.epoch,
            intent: this.generation,
        };
        this.set({
            page: {
                ...page,
                origin,
                nodes: page.nodes.map(node => ({ ...node, scope: this.runtime.scope(node.scope, origin) })),
            },
        });
    }

    /** Starts an attempt to go to an address: by the document when it is no page of this application. */
    private begin(url: URL, options: NavigationOptions, document: boolean): Promise<NavigationResult> {
        const inside = url.origin === location.origin;
        const outside = document || !inside || this.match(url.pathname) === null;
        const intent: NavigationIntent = {
            href: inside ? url.pathname + url.search + url.hash : url.href,
            type: options.replace ? 'replace' : 'push',
        };
        return this.attempt(intent, options, this.intend(), [...this.blockers], outside ? url.href : null);
    }

    /** Goes where a loader said to go instead, in place of the entry that asked. */
    private follow(target: { href: string; mode: 'internal' | 'document' }): Promise<NavigationResult> {
        return this.begin(
            new URL(target.href, location.origin),
            { replace: true },
            target.mode === 'document',
        );
    }

    /**
     * Whether what was loaded may be shown as who is known to be signed in. "stale" is an answer
     * older than that, which is dropped; "barred" says who is signed in came into doubt, and the
     * page is being loaded again as whoever the browser is now: nothing of this answer is shown.
     */
    private admit(loaded: Exclude<Loaded, { type: 'redirect' }>): 'shown' | 'stale' | 'barred' {
        if (loaded.type === 'problem' && loaded.nodes.length === 0) {
            // A refusal that carries nobody's data shows nobody's data.
            return 'shown';
        }
        // One that carries what the layouts before it loaded says whose that is, as a page does:
        // without it, where the application says who on every page, it is not shown.
        const standing = this.runtime.witness(loaded.auth);
        return standing === 'doubtful' ? 'barred' : standing === 'stale' ? 'stale' : 'shown';
    }

    private attempt(
        intent: NavigationIntent,
        options: NavigationOptions,
        generation: number,
        blockers: Blocker[],
        leave: string | null,
    ): Promise<NavigationResult> {
        for (let index = 0; index < blockers.length; index++) {
            const blocker = blockers[index]!;
            if (blocker.disposed || !blocker.test(intent)) {
                continue;
            }
            const rest = blockers.slice(index + 1);
            blocker.hold({
                intent,
                generation,
                epoch: this.runtime.epoch,
                release: () => this.attempt(intent, options, generation, rest, leave),
            });
            // Held, the page shown stays: under its own address, should a step through history have moved it.
            this.realign();
            return Promise.resolve({ status: 'blocked' });
        }
        if (leave !== null) {
            // No page of this application: the browser's own navigation, once nothing holds it back.
            this.leave(leave, intent.type === 'replace');
            // Should the document stay after all, as for a download, the page shown can go on.
            this.republish();
            return Promise.resolve({ status: 'document', href: leave });
        }
        return this.go(intent, options, generation);
    }

    private async go(
        intent: NavigationIntent,
        options: NavigationOptions,
        generation: number,
    ): Promise<NavigationResult> {
        let url = new URL(intent.href, location.origin);
        const here = new URL(this.snapshot.location.href, location.origin);
        if (
            url.pathname === here.pathname &&
            url.search === here.search &&
            url.hash !== here.hash &&
            url.hash !== ''
        ) {
            // The same page at another place in it: nothing is loaded.
            this.saveScroll();
            const entryKey = this.write(intent.type === 'replace', intent.href, options.state ?? null);
            this.set({
                location: { href: intent.href, entryKey, state: options.state ?? null },
                pending: null,
            });
            this.republish();
            if (options.scroll !== 'preserve') {
                this.toHash();
            }
            return { status: 'committed', href: intent.href };
        }
        const epoch = this.runtime.epoch;
        const from = this.snapshot.page?.commit;
        const controller = new AbortController();
        this.controller = controller;
        this.set({ pending: { href: intent.href }, navigationError: null });
        let replace = intent.type === 'replace';
        try {
            let loaded = await this.load(url.pathname + url.search, controller.signal);
            for (let hops = 0; loaded.type === 'redirect'; hops++) {
                if (generation !== this.generation) {
                    return { status: 'superseded' };
                }
                if (hops >= 8) {
                    throw new RequestFailure('protocol', 'The page redirects without end.', 'rejected');
                }
                url = new URL(loaded.href, location.origin);
                if (
                    loaded.mode === 'document' ||
                    url.origin !== location.origin ||
                    this.match(url.pathname) === null
                ) {
                    this.set({ pending: null });
                    this.leave(url.href, replace || loaded.replace);
                    this.republish();
                    return { status: 'document', href: url.href };
                }
                replace = replace || loaded.replace;
                loaded = await this.load(url.pathname + url.search, controller.signal);
            }
            if (generation !== this.generation || epoch !== this.runtime.epoch) {
                return { status: 'superseded' };
            }
            const admitted = this.admit(loaded);
            if (admitted === 'barred') {
                // Who is signed in came into doubt: the page is being settled, and this is not shown.
                return { status: 'superseded' };
            }
            if (admitted === 'stale') {
                throw new RequestFailure('auth', outdated, 'rejected');
            }
            const href = url.pathname + url.search + url.hash;
            this.saveScroll();
            const state = options.state ?? null;
            const entryKey = this.write(replace, href, state);
            const scroll = options.scroll === 'preserve' ? 'none' : url.hash !== '' ? 'hash' : 'top';
            this.focusNext = true;
            this.controller = null;
            this.set({
                location: { href, entryKey, state },
                pending: null,
                navigationError: null,
                page: this.page(loaded, href, { entryKey, epoch, intent: generation }, scroll),
            });
            this.head(this.snapshot.page!.head);
            return { status: 'committed', href };
        } catch (error) {
            if (generation !== this.generation) {
                return { status: 'superseded' };
            }
            this.set({ pending: null });
            // The page shown stays: it is given an origin of now, and what began before the attempt stays stale.
            this.republish();
            if (!(error instanceof RequestFailure)) {
                throw error;
            }
            if (error.kind === 'build' && this.reloadOnce(url.href, replace)) {
                // The application was updated: the address is asked for as a document, once.
                return { status: 'document', href: url.href };
            }
            // It came to nothing: the page shown keeps its own address.
            this.realign();
            return {
                status: 'failed',
                error: this.fail(intent.href, error, () =>
                    // A retry belongs to the page it failed on: once another is shown, it is nobody's.
                    from === this.snapshot.page?.commit
                        ? this.navigate(intent.href, { ...options, ifCurrent: undefined })
                        : Promise.resolve({ status: 'superseded' }),
                ),
            };
        }
    }

    private popped = (): void => {
        const own = plain(history.state) && plain(history.state.psx) ? history.state.psx : null;
        if (own === null || typeof own.key !== 'string' || typeof own.index !== 'number') {
            if ((history.state ?? null) === null && this.elsewhere()) {
                return;
            }
            // An entry this application did not make: only the document knows what it shows.
            window.location.reload();
            return;
        }
        if (this.expectPop !== null) {
            const expected = this.expectPop;
            this.expectPop = null;
            if (own.key === expected) {
                // The address put back by this router: nothing was navigated.
                return;
            }
        }
        if (this.snapshot.reconciling) {
            // Who is signed in is not settled: only the document can say what this entry shows.
            this.leave(location.origin + location.pathname + location.search);
            return;
        }
        const href = location.pathname + location.search + location.hash;
        const delta = own.index - this.index;
        const key = own.key;
        const index = own.index;
        const state = (own.state as JsonValue) ?? null;
        const here = new URL(this.snapshot.location.href, location.origin);
        if (location.pathname === here.pathname && location.search === here.search) {
            this.saveScroll();
            this.intend();
            this.index = index;
            this.set({ location: { href, entryKey: key, state } });
            this.republish();
            if (location.hash !== '') {
                this.toHash();
            } else {
                const [x, y] = this.scrolls.get(key) ?? [0, 0];
                window.scrollTo(x, y);
            }
            return;
        }
        const intent: NavigationIntent = { href, type: 'pop' };
        const generation = this.intend();
        // By where the browser is and where the page shown is, never by what a step was thought to be.
        const restore = (): void => this.realign();
        if (!this.passPop) {
            for (const blocker of this.blockers) {
                if (!blocker.disposed && blocker.test(intent)) {
                    // The address had already changed: it is put back, and the attempt is held.
                    restore();
                    blocker.hold({
                        intent,
                        generation,
                        epoch: this.runtime.epoch,
                        release: () => {
                            this.passPop = true;
                            history.go(delta);
                            return Promise.resolve({ status: 'committed', href });
                        },
                    });
                    return;
                }
            }
        }
        this.passPop = false;
        const epoch = this.runtime.epoch;
        const controller = new AbortController();
        this.controller = controller;
        const traversal = { href, key, index, state };
        this.traversal = traversal;
        const arrived = (): void => {
            if (this.traversal === traversal) {
                this.traversal = null;
            }
        };
        this.saveScroll();
        this.set({ pending: { href } });
        void (async () => {
            try {
                const loaded = await this.load(location.pathname + location.search, controller.signal);
                if (generation !== this.generation || epoch !== this.runtime.epoch) {
                    arrived();
                    return;
                }
                if (loaded.type === 'redirect') {
                    // The entry no longer is a page of its own: go where it says, in its place.
                    arrived();
                    this.index = index;
                    this.set({ location: { href, entryKey: key, state }, pending: null });
                    await this.follow(loaded);
                    return;
                }
                // Should who is signed in come into doubt here, the settling takes this entry as the place.
                const admitted = this.admit(loaded);
                arrived();
                if (admitted === 'barred') {
                    return;
                }
                if (admitted === 'stale') {
                    throw new RequestFailure('auth', outdated, 'rejected');
                }
                this.index = index;
                this.focusNext = true;
                this.controller = null;
                this.set({
                    location: { href, entryKey: key, state },
                    pending: null,
                    navigationError: null,
                    page: this.page(
                        loaded,
                        href,
                        { entryKey: key, epoch, intent: generation },
                        location.hash !== '' ? 'hash' : 'restore',
                    ),
                });
                this.head(this.snapshot.page!.head);
            } catch (error) {
                arrived();
                if (generation !== this.generation) {
                    return;
                }
                this.set({ pending: null });
                this.republish();
                if (!(error instanceof RequestFailure)) {
                    this.runtime.onError?.(error as Error, { kind: 'protocol', build: this.runtime.build });
                    return;
                }
                if (error.kind === 'build') {
                    window.location.reload();
                    return;
                }
                // Old content is never left under the new address: the entry it came from is restored.
                restore();
                this.fail(href, error, () => this.navigate(href));
            }
        })();
    };

    private shown = (event: PageTransitionEvent): void => {
        if (event.persisted) {
            // Back from the browser's own cache: what it shows may be of before.
            void this.revalidate().catch(() => undefined);
        }
    };

    private fail(
        href: string,
        failure: RequestFailure,
        retry: () => Promise<NavigationResult>,
    ): NavigationFailure {
        const error: NavigationFailure = {
            href,
            failure,
            retry,
            dismiss: () => {
                if (this.snapshot.navigationError === error) {
                    this.set({ navigationError: null });
                }
            },
        };
        this.set({ navigationError: error });
        return error;
    }

    /**
     * The browser's own step to another place in the page shown: a plain anchor to a hash, or a
     * hash typed into the address. Its entry has no state and nothing is loaded for it; it is made
     * this page's, after the entry it was stepped from. The browser has placed the scroll already.
     */
    private elsewhere(): boolean {
        if (
            this.snapshot.page === null ||
            this.snapshot.reconciling ||
            this.traversal !== null ||
            this.expectPop !== null
        ) {
            // The page and the address are apart, or about to be: the document says what this is.
            return false;
        }
        const here = new URL(this.snapshot.location.href, location.origin);
        if (location.pathname !== here.pathname || location.search !== here.search) {
            return false;
        }
        this.intend();
        const href = location.pathname + location.search + location.hash;
        // The same hash again takes the place of its entry; another one follows it.
        const again = location.hash === here.hash;
        const entryKey = again ? this.snapshot.location.entryKey : newKey();
        if (!again) {
            this.index++;
        }
        history.replaceState({ psx: { key: entryKey, index: this.index, state: null } }, '', location.href);
        this.set({ location: { href, entryKey, state: null } });
        this.republish();
        return true;
    }

    /** Writes the history entry of what is about to be shown, keeping what else is in its state. */
    private write(replace: boolean, href: string, state: JsonValue | null): string {
        // The entry written from is the one the browser is at. A step through history that was
        // overtaken before it showed anything had moved there already: what is pushed follows that
        // entry, and what is replaced is that entry, whatever the page shown was of.
        const own = this.physical();
        this.traversal = null;
        this.expectPop = null;
        if (own !== null) {
            this.index = own.index;
        }
        if (replace) {
            const entryKey = own?.key ?? this.snapshot.location.entryKey;
            const existing = plain(history.state) ? history.state : {};
            history.replaceState({ ...existing, psx: { key: entryKey, index: this.index, state } }, '', href);
            return entryKey;
        }
        const entryKey = newKey();
        this.index++;
        history.pushState({ psx: { key: entryKey, index: this.index, state } }, '', href);
        return entryKey;
    }

    private saveScroll(): void {
        this.scrolls.set(this.snapshot.location.entryKey, [window.scrollX, window.scrollY]);
        if (this.scrolls.size > 100) {
            this.scrolls.delete(this.scrolls.keys().next().value!);
        }
    }

    private toHash(): void {
        let id = location.hash.slice(1);
        try {
            id = decodeURIComponent(id);
        } catch {
            // Looked for as written.
        }
        const target =
            id === '' ? null : (document.getElementById(id) ?? document.getElementsByName(id)[0] ?? null);
        if (target !== null) {
            target.scrollIntoView();
        } else {
            window.scrollTo(0, 0);
        }
    }

    private reloadOnce(href: string, replace = false): boolean {
        try {
            const last = Number(sessionStorage.getItem('psx-reloaded') ?? '0');
            if (Date.now() - last < 10_000) {
                return false;
            }
            sessionStorage.setItem('psx-reloaded', String(Date.now()));
        } catch {
            return false;
        }
        this.leave(href, replace);
        return true;
    }

    private fresh(entry: { at: number; epoch: number }): boolean {
        return (
            entry.epoch === this.runtime.epoch &&
            Date.now() - entry.at < this.runtime.limits.prefetchTtlSeconds * 1000
        );
    }

    /** Asks for a page's data and loads its modules, together. */
    private async load(href: string, signal?: AbortSignal, fresh = false): Promise<Loaded> {
        const url = new URL(href, location.origin);
        const path = url.pathname + url.search;
        if (!fresh) {
            const known = this.prefetched.get(path);
            this.prefetched.delete(path);
            if (known !== undefined && this.fresh(known)) {
                try {
                    const ahead = await known.promise;
                    if (
                        ahead.type === 'redirect' ||
                        (ahead.type === 'problem' && ahead.nodes.length === 0) ||
                        this.runtime.standing(ahead.auth) === 'current'
                    ) {
                        return ahead;
                    }
                    // It says who was signed in when it was fetched, which is not who is now: ask again.
                } catch {
                    // What was fetched ahead failed: ask again, now that it matters.
                }
            }
        }
        // Its modules are very likely these: they load while the data does.
        const guess = this.match(url.pathname);
        if (guess !== null) {
            for (const node of this.runtime.manifest.routes[guess]!.nodes) {
                void this.runtime.manifest.modules[node.module]?.().catch(() => undefined);
            }
        }
        const answer = await exchange({
            transport: this.runtime.transport,
            build: this.runtime.build,
            maxBytes: this.runtime.limits.maxResponseBytes,
            method: 'GET',
            url: path,
            schema: this.runtime.manifest.navigation,
            expects: 'page',
            signal,
        });
        if (answer.kind === 'redirect') {
            return {
                type: 'redirect',
                href: answer.target.href,
                mode: answer.target.mode,
                replace: answer.target.replace,
            };
        }
        if (answer.kind === 'problem') {
            return this.read(
                {
                    kind: 'problem',
                    problem: answer.problem,
                    pageError: answer.pageError,
                    auth: answer.auth,
                },
                path,
                true,
            );
        }
        return this.read(answer.envelope, path);
    }

    /** Checks an envelope against what the build says this release's pages are, and loads their modules. */
    private async read(envelope: unknown, href: string, trusted = false): Promise<Loaded> {
        const bad = (why: string): never => {
            const failure = new RequestFailure('protocol', `The page cannot be read: ${why}.`, 'rejected');
            this.runtime.onError?.(failure, { kind: 'protocol', build: this.runtime.build });
            throw failure;
        };
        if (!plain(envelope)) {
            return bad('it is not an envelope');
        }
        let source: Record<string, unknown> | null = envelope;
        let problem: PublicProblem | null = null;
        if (envelope.kind === 'problem') {
            problem = trusted ? (envelope.problem as PublicProblem) : readProblem(envelope.problem);
            if (problem === null) {
                return bad('its problem is malformed');
            }
            source =
                plain(envelope.pageError) && envelope.pageError.build === this.runtime.build
                    ? envelope.pageError
                    : null;
        } else if (envelope.kind !== 'page') {
            return bad('it is not a page');
        }
        const routeId =
            source !== null && plain(source.route) && typeof source.route.id === 'string'
                ? source.route.id
                : null;
        const route = routeId === null ? undefined : this.runtime.manifest.routes[routeId];
        const nodes: WireNode[] = [];
        const exports: PageModule[] = [];
        if (source !== null) {
            if (
                route === undefined ||
                !Array.isArray(source.nodes) ||
                source.nodes.length > route.nodes.length
            ) {
                return bad('its route is not one of this release');
            }
            if (problem === null && source.nodes.length !== route.nodes.length) {
                return bad('it does not have the loaders its route has');
            }
            for (let index = 0; index < source.nodes.length; index++) {
                const node = source.nodes[index] as unknown;
                const declared = route.nodes[index]!;
                if (
                    !plain(node) ||
                    node.mount !== declared.mount ||
                    node.module !== declared.module ||
                    typeof node.key !== 'string' ||
                    !plain(node.scope) ||
                    node.scope.mountId !== declared.mount ||
                    typeof node.scope.href !== 'string' ||
                    !plain(node.scope.params) ||
                    Object.values(node.scope.params).some(value => typeof value !== 'string')
                ) {
                    return bad(`its loader ${index} is not the one its route declares`);
                }
                const found = mismatch(
                    declared.shape as Shape,
                    node.data,
                    `nodes[${index}].data`,
                    0,
                    this.runtime.limits.maxDepth,
                );
                if (found !== null) {
                    return bad(found);
                }
                nodes.push(node as unknown as WireNode);
            }
        }
        const wanted =
            route === undefined
                ? []
                : route.nodes.slice(
                      0,
                      problem === null ? nodes.length : Math.min(nodes.length + 1, route.nodes.length),
                  );
        try {
            for (const loaded of await Promise.all(
                wanted.map(node => this.runtime.manifest.modules[node.module]!()),
            )) {
                exports.push(loaded as PageModule);
            }
        } catch {
            // A script of this release that can no longer be fetched: the release was replaced.
            throw new RequestFailure(
                'build',
                'A part of the page could not be loaded. Reload the page.',
                'rejected',
            );
        }
        const head = source !== null && plain(source.head) ? readHead(source.head) : emptyHead;
        const tags =
            source !== null && Array.isArray(source.tags)
                ? source.tags.filter((tag): tag is string => typeof tag === 'string')
                : [];
        if (problem !== null) {
            return {
                type: 'problem',
                problem,
                routeId,
                nodes,
                exports: exports.slice(0, nodes.length),
                failed: exports[nodes.length] ?? null,
                head,
                tags,
                auth: whose(readAuth(envelope.auth), source === null ? null : readAuth(source.auth)),
            };
        }
        const auth = readAuth(envelope.auth);
        return { type: 'page', routeId: routeId!, href, nodes, exports, head, tags, auth };
    }

    private page(
        loaded: Exclude<Loaded, { type: 'redirect' }>,
        href: string,
        origin: NavigationOrigin,
        scroll: PageState['scroll'],
        commit?: number,
    ): PageState {
        return {
            routeId: loaded.routeId,
            href,
            nodes: loaded.nodes.map((node, index) => ({
                mount: node.mount,
                module: node.module,
                key: node.key,
                data: node.data,
                scope: this.runtime.scope(node.scope, origin),
                exports: loaded.exports[index]!,
            })),
            problem: loaded.type === 'problem' ? loaded.problem : null,
            failed: loaded.type === 'problem' ? loaded.failed : null,
            head: loaded.head,
            tags: loaded.tags,
            origin,
            commit: commit ?? ++this.commits,
            scroll,
        };
    }

    /** Puts the page's title and its own meta and link tags in the document, in place of the last page's. */
    private head(head: WireHead): void {
        if (this.runtime.server) {
            return;
        }
        document.title = head.title ?? '';
        for (const stale of [...document.head.querySelectorAll('[data-psx-head]')]) {
            stale.remove();
        }
        for (const [tag, entries] of [
            ['meta', head.meta],
            ['link', head.links],
        ] as const) {
            for (const [key, attributes] of Object.entries(entries)) {
                const element = document.createElement(tag);
                element.setAttribute('data-psx-head', key);
                for (const [name, value] of Object.entries(attributes)) {
                    if (
                        /^(?:name|property|content|http-equiv|rel|href|type|sizes|media|hreflang|title)$/.test(
                            name,
                        ) &&
                        typeof value === 'string'
                    ) {
                        element.setAttribute(name, value);
                    }
                }
                document.head.appendChild(element);
            }
        }
    }

    private set(change: Partial<RouterSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...change };
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

function pattern(segment: Segment): string {
    if ('text' in segment) {
        return segment.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    if (segment.expression === null) {
        return '[^/]+';
    }
    try {
        new RegExp(segment.expression);
        return `(?:${segment.expression})`;
    } catch {
        // An expression only PHP reads: anything is let through, and the server decides.
        return '.+';
    }
}

function newKey(): string {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const outdated = 'This answer is older than what the page already knows of who is signed in. Load it again.';

function readHead(value: Record<string, unknown>): WireHead {
    const group = (entries: unknown): Record<string, Record<string, string>> => {
        const read: Record<string, Record<string, string>> = {};
        if (plain(entries)) {
            for (const key of Object.keys(entries).slice(0, 100)) {
                const attributes = entries[key];
                if (plain(attributes)) {
                    read[key] = Object.fromEntries(
                        Object.entries(attributes).filter(
                            (pair): pair is [string, string] => typeof pair[1] === 'string',
                        ),
                    );
                }
            }
        }
        return read;
    };
    return {
        title: typeof value.title === 'string' ? value.title : null,
        meta: group(value.meta),
        links: group(value.links),
    };
}

/**
 * Whose data a refusal carries: what the envelope says, or what the part that holds the data says.
 * Where both speak they must say the same; one that contradicts the other is nobody's word.
 */
function whose(envelope: AuthSnapshot | null, carried: AuthSnapshot | null): AuthSnapshot | null {
    if (envelope === null || carried === null) {
        return envelope ?? carried;
    }
    return envelope.context === carried.context &&
        envelope.revision === carried.revision &&
        envelope.partition === carried.partition
        ? envelope
        : null;
}
