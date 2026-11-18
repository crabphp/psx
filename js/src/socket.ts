import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

export interface RendererOptions {
    socket: string;
    /** The release this renderer is of; null for development's, which renders whatever is current. */
    build: string | null;
    /** The envelope to render, and the document's nonce when the application sets one. */
    render: (envelope: unknown, nonce: string | null) => Promise<string>;
    maxRequestBytes?: number;
    maxHtmlBytes?: number;
    maxInflight?: number;
    maxQueue?: number;
    timeoutSeconds?: number;
    log?: (line: string) => void;
    /** Told how many renders run and how many wait, each time either changes. */
    observe?: (state: { inflight: number; queued: number }) => void;
}

/**
 * Listens on a private Unix socket for pages to render. A message is its length in four bytes and
 * then JSON; one connection carries one request. It is given a page's envelope and nothing else,
 * renders only what its own bundle holds, and refuses a request of another release.
 */
export function listen(options: RendererOptions): Server {
    const maxRequest = options.maxRequestBytes ?? 3 * 1024 * 1024;
    const maxHtml = options.maxHtmlBytes ?? 4 * 1024 * 1024;
    const maxInflight = options.maxInflight ?? 16;
    const maxQueue = options.maxQueue ?? 32;
    const timeout = (options.timeoutSeconds ?? 5) * 1000;
    const log = options.log ?? (line => process.stderr.write(`${line}\n`));
    let inflight = 0;
    const queue: Job[] = [];

    mkdirSync(dirname(options.socket), { recursive: true, mode: 0o700 });
    if (existsSync(options.socket)) {
        if (!lstatSync(options.socket).isSocket()) {
            throw new Error(`${options.socket} is not a socket; the renderer will not replace it.`);
        }
        unlinkSync(options.socket);
    }

    const answer = (socket: Socket, message: object): void => {
        if (socket.destroyed || !socket.writable) {
            return;
        }
        const body = Buffer.from(JSON.stringify(message));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(body.length);
        socket.end(Buffer.concat([head, body]));
    };

    /**
     * One page asked for. It is answered once, by its render or by its time running out, and not
     * at all once whoever asked has gone.
     */
    interface Job {
        socket: Socket;
        message: Record<string, unknown>;
        arrived: number;
        timer: ReturnType<typeof setTimeout> | undefined;
        running: boolean;
        answered: boolean;
    }

    const changed = (): void => options.observe?.({ inflight, queued: queue.length });

    const failed = (job: Job, reason: string): void => {
        const envelope = job.message.envelope as
            { requestId?: unknown; route?: { id?: unknown } } | undefined;
        // The request and the route say which page it was; its data is never written down.
        log(
            `psx-ssr: render failed build=${options.build ?? 'dev'} request=${String(envelope?.requestId ?? '-')} route=${String(envelope?.route?.id ?? '-')} after=${Date.now() - job.arrived}ms: ${reason}`,
        );
    };

    /** Answers a job if nothing has yet and whoever asked is still there; whatever comes later is dropped. */
    const settle = (job: Job, message: object | null): void => {
        if (job.answered) {
            return;
        }
        job.answered = true;
        clearTimeout(job.timer);
        if (!job.running) {
            // It will never run: its place in the queue is another's.
            const at = queue.indexOf(job);
            if (at !== -1) {
                queue.splice(at, 1);
                changed();
            }
        }
        if (message !== null && !job.socket.destroyed && job.socket.writable) {
            answer(job.socket, message);
        }
    };

    /**
     * Runs what waits while there is room. A render holds its place until it has really ended:
     * that it was answered for, by its time running out or by its asker going, ends nothing, and
     * a place given away then would let any number of renders run at once.
     */
    const next = (): void => {
        while (inflight < maxInflight) {
            const job = queue.shift();
            if (job === undefined) {
                break;
            }
            if (job.answered) {
                continue;
            }
            inflight++;
            job.running = true;
            void Promise.resolve()
                .then(() =>
                    options.render(
                        job.message.envelope,
                        typeof job.message.nonce === 'string' ? job.message.nonce : null,
                    ),
                )
                .then(
                    html => {
                        if (job.answered) {
                            return;
                        }
                        if (Buffer.byteLength(html) > maxHtml) {
                            failed(job, 'The rendered page is larger than the renderer may send.');
                            settle(job, { ok: false, error: 'The page could not be rendered.' });
                            return;
                        }
                        settle(job, { ok: true, html });
                    },
                    (error: unknown) => {
                        if (!job.answered) {
                            failed(job, error instanceof Error ? error.message : String(error));
                            settle(job, { ok: false, error: 'The page could not be rendered.' });
                        }
                    },
                )
                .finally(() => {
                    inflight--;
                    changed();
                    next();
                });
        }
        changed();
    };

    /** Takes a page to render, or says there is no room: what waits is bounded as what runs is. */
    const accept = (socket: Socket, message: Record<string, unknown>): void => {
        if (inflight >= maxInflight && queue.length >= maxQueue) {
            answer(socket, { ok: false, error: 'The renderer is busy.' });
            return;
        }
        const job: Job = {
            socket,
            message,
            arrived: Date.now(),
            timer: undefined,
            running: false,
            answered: false,
        };
        // Its time runs from when it was asked for: whoever asked waits no longer than that either.
        job.timer = setTimeout(() => {
            failed(
                job,
                job.running ? 'The render took too long.' : 'The render waited too long for its turn.',
            );
            settle(job, { ok: false, error: 'The page could not be rendered.' });
        }, timeout);
        socket.once('close', () => settle(job, null));
        queue.push(job);
        next();
    };

    const state: Held = { holders: new Set(), retire: null };
    const server = createServer(socket => {
        const chunks: Buffer[] = [];
        let received = 0;
        let expected: number | null = null;
        let done = false;
        socket.setTimeout(timeout, () => socket.destroy());
        socket.on('error', () => socket.destroy());
        socket.on('data', chunk => {
            if (done) {
                return;
            }
            chunks.push(chunk);
            received += chunk.length;
            if (expected === null && received >= 4) {
                expected = Buffer.concat(chunks).readUInt32BE(0);
                if (expected > maxRequest) {
                    done = true;
                    answer(socket, { ok: false, error: 'The request is larger than the renderer accepts.' });
                    return;
                }
            }
            if (expected === null || received < expected + 4) {
                return;
            }
            done = true;
            // The request is whole: from here the render has its own limit, and the wait for it is not idleness.
            socket.setTimeout(0);
            let request: unknown;
            try {
                request = JSON.parse(
                    Buffer.concat(chunks)
                        .subarray(4, expected + 4)
                        .toString('utf8'),
                );
            } catch {
                request = null;
            }
            if (
                typeof request !== 'object' ||
                request === null ||
                (request as { protocol?: unknown }).protocol !== 1
            ) {
                answer(socket, { ok: false, error: 'The request is not of protocol 1.' });
                return;
            }
            const message = request as Record<string, unknown>;
            if (options.build !== null && message.build !== options.build) {
                answer(socket, { ok: false, error: 'This renderer is of another release.' });
                return;
            }
            if (message.ping === true) {
                answer(socket, { ok: true });
                return;
            }
            if (message.hold === true) {
                // A worker of the server this renderer is of, saying it may still ask for pages:
                // it stays connected, sending nothing more, until it has stopped.
                if (state.holders.size >= maxHolders) {
                    answer(socket, { ok: false, error: 'Too many are connected to the renderer.' });
                    return;
                }
                state.holders.add(socket);
                socket.once('close', () => {
                    state.holders.delete(socket);
                    if (state.holders.size === 0) {
                        state.retire?.();
                    }
                });
                const body = Buffer.from(JSON.stringify({ ok: true }));
                const head = Buffer.alloc(4);
                head.writeUInt32BE(body.length);
                socket.write(Buffer.concat([head, body]));
                return;
            }
            accept(socket, message);
        });
    });
    server.listen(options.socket, () => {
        // Only the account that runs the application talks to it.
        chmodSync(options.socket, 0o600);
    });
    const close = (): void => {
        server.close();
        try {
            unlinkSync(options.socket);
        } catch {
            // Already gone.
        }
    };
    server.on('close', () => {
        process.off('exit', close);
    });
    process.once('exit', close);
    held.set(server, state);
    return server;
}

/** Who stays connected to a renderer, and what it is to do once none does. */
interface Held {
    holders: Set<Socket>;
    retire: (() => void) | null;
}

const held = new WeakMap<Server, Held>();

/** More than any server has workers: past it a connection is refused rather than kept. */
const maxHolders = 1024;

/**
 * Stops a renderer the way its server stops: the workers that said they may still ask for pages
 * are served until the last of them has gone, and the renders under way are finished. A server
 * that reloads finishes the requests it has, and a page among them is still rendered.
 */
export function retire(server: Server, done: () => void): void {
    const state = held.get(server);
    const finish = (): void => {
        if (state !== undefined) {
            state.retire = null;
        }
        server.close(done);
    };
    if (state === undefined || state.holders.size === 0) {
        finish();
        return;
    }
    state.retire = finish;
}
