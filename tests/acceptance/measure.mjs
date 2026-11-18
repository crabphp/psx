// Measures a page of PSX against an ordinary Crab route that gives the same data, on this machine:
// how many are answered a second, how long each takes, and what the server's processes hold in
// memory before and after. It is a comparison, not a benchmark: the same client, the same server,
// two workers, the JIT off, one after the other.
//
//   ACCEPTANCE_WORK=/tmp/x node measure.mjs            # 3000 requests a route, 8 at a time
//   node measure.mjs --requests=10000 --concurrency=16
//
// It prints a table and writes the same numbers to <work>/measurements.json.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { application, build, pause, port, work } from './lib/harness.mjs';

const option = (name, fallback) => Number(process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const requests = option('requests', 3000);
const concurrency = option('concurrency', 8);
const rounds = option('rounds', 3);
// Said to PHP itself, so that it holds whatever the machine's own settings are.
const php = ['-d', 'opcache.jit=disable', '-d', 'opcache.jit_buffer_size=0'];

// The same two hundred lines the page /long loads, from an ordinary route of the framework's.
const ordinary = `
Route::get('/plain/lines', static function (): array {
    $lines = [];
    for ($line = 1; $line <= 200; $line++) {
        $lines[] = "page 1, line {$line}";
    }
    return ['page' => 1, 'lines' => $lines];
});
`;

/** The processes under one, by what they run, with what each holds in memory (kB). */
function processes(root) {
    const found = [];
    const walk = parent => {
        let lines;
        try {
            lines = execFileSync('ps', ['-o', 'pid=,rss=,args=', '--ppid', String(parent)], { encoding: 'utf8' }).split('\n');
        } catch {
            return;
        }
        for (const line of lines) {
            const [, pid, rss, args] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
            if (pid !== undefined) {
                found.push({ pid: Number(pid), rss: Number(rss), kind: args.includes('ssr/server.mjs') ? 'renderer' : args.startsWith('php') ? 'php' : 'other' });
                walk(pid);
            }
        }
    };
    walk(root);
    return found;
}
const memory = root => {
    const all = processes(root);
    const of = kind => all.filter(one => one.kind === kind);
    return {
        phpProcesses: of('php').length,
        phpRssMb: Math.round(of('php').reduce((sum, one) => sum + one.rss, 0) / 102.4) / 10,
        rendererRssMb: Math.round(of('renderer').reduce((sum, one) => sum + one.rss, 0) / 102.4) / 10,
    };
};

async function serve(dir) {
    const at = port();
    const url = `http://127.0.0.1:${at}`;
    const log = join(dir, 'measure.log');
    const child = spawn('php', [...php, 'cua', 'start'], {
        cwd: dir,
        env: { ...process.env, SERVER_ADDRESS: `tcp://127.0.0.1:${at}`, APP_URL: url, SERVER_WORKERS: '2' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => appendFileSync(log, chunk));
    child.stderr.on('data', chunk => appendFileSync(log, chunk));
    for (let waited = 0; ; waited++) {
        try {
            if ((await fetch(`${url}/up`, { signal: AbortSignal.timeout(2000) })).ok) {
                break;
            }
        } catch {
            // Not listening yet.
        }
        if (waited > 200) {
            child.kill('SIGTERM');
            throw new Error(`The server did not answer:\n${readFileSync(log, 'utf8').slice(-2000)}`);
        }
        await pause(150);
    }
    return {
        url,
        pid: child.pid,
        stop: () =>
            new Promise(done => {
                child.once('exit', done);
                child.kill('SIGTERM');
            }),
    };
}

/** Asks for one address so many times, so many at once, and says how it went. */
async function load(url, headers, expect) {
    const times = [];
    let next = 0;
    let bytes = 0;
    const refused = {};
    const started = performance.now();
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            while (next < requests) {
                next++;
                const from = performance.now();
                const answer = await fetch(url, { headers });
                const body = await answer.text();
                times.push(performance.now() - from);
                bytes = body.length;
                if (answer.status !== 200 || !body.includes(expect)) {
                    refused[answer.status] = (refused[answer.status] ?? 0) + 1;
                }
            }
        }),
    );
    const seconds = (performance.now() - started) / 1000;
    times.sort((a, b) => a - b);
    const at = share => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * share))] * 100) / 100;
    return { perSecond: Math.round(times.length / seconds), p50: at(0.5), p95: at(0.95), p99: at(0.99), bytes, refused };
}

const results = { requests, concurrency, rounds, php: execFileSync('php', [...php, '-r', 'echo PHP_VERSION, " jit=", var_export(opcache_get_status()["jit"]["enabled"] ?? null, true);'], { encoding: 'utf8' }), node: process.version, runs: {} };
console.log(`work: ${work}\nPHP ${results.php}, Node ${results.node}; ${requests} requests a route, ${concurrency} at a time, the best of ${rounds} rounds`);

const browser = await chromium.launch();
try {
    for (const rendering of ['client', 'server']) {
        const dir = await application(`measure-${rendering}`, { PSX_RENDERING: rendering, ACCEPTANCE_CSP: 'false' });
        appendFileSync(join(dir, 'routes', 'web.php'), ordinary);
        await build(dir);
        const server = await serve(dir);
        try {
            // What the browser itself sends for a navigation, taken from a real one.
            const page = await (await browser.newContext({ baseURL: server.url })).newPage();
            await page.goto('/long');
            await page.locator('html[data-alive="yes"]').waitFor({ state: 'attached' });
            const [sent] = await Promise.all([
                page.waitForRequest(request => (request.headers().accept ?? '').includes('application/vnd.crab.psx+json')),
                page.getByRole('link', { name: 'Next', exact: true }).click(),
            ]);
            const navigation = Object.fromEntries(Object.entries(sent.headers()).filter(([name]) => name === 'accept' || name.startsWith('x-psx-')));
            await page.context().close();

            const routes = {
                'ordinary route, JSON': [`${server.url}/plain/lines`, { Accept: 'application/json' }, '"page 1, line 200"'],
                'page, navigation (JSON)': [`${server.url}/long?page=1`, navigation, 'page 1, line 200'],
                [`page, document (${rendering === 'server' ? 'rendered by the server' : 'rendered in the browser'})`]: [`${server.url}/long?page=1`, { Accept: 'text/html' }, 'page 1, line 200'],
            };
            const run = { started: memory(server.pid), routes: {} };
            for (const [url, headers, expect] of Object.values(routes)) {
                // Warm: code compiled, caches filled, the renderer's modules loaded.
                await load(url, headers, expect);
            }
            run.warm = memory(server.pid);
            for (const [name, [url, headers, expect]] of Object.entries(routes)) {
                let best = null;
                for (let round = 0; round < rounds; round++) {
                    const one = await load(url, headers, expect);
                    if (Object.keys(one.refused).length > 0) {
                        throw new Error(`${name}: refused ${JSON.stringify(one.refused)}`);
                    }
                    if (best === null || one.perSecond > best.perSecond) {
                        best = one;
                    }
                }
                run.routes[name] = best;
            }
            run.after = memory(server.pid);
            const assets = join(dir, 'public', 'assets', 'psx', 'assets');
            run.scripts = Object.fromEntries(readdirSync(assets).filter(name => /^(entry|Long\.psx)-.*\.js$/.test(name)).map(name => [name.replace(/-[^.]+\.js$/, '.js'), statSync(join(assets, name)).size]));
            results.runs[rendering] = run;

            const base = run.routes['ordinary route, JSON'];
            console.log(`\n=== psx.rendering = ${rendering} ===`);
            console.log('route'.padEnd(46) + 'req/s'.padStart(8) + 'p50 ms'.padStart(9) + 'p95 ms'.padStart(9) + 'p99 ms'.padStart(9) + 'bytes'.padStart(9) + '  of ordinary');
            for (const [name, one] of Object.entries(run.routes)) {
                console.log(name.padEnd(46) + String(one.perSecond).padStart(8) + String(one.p50).padStart(9) + String(one.p95).padStart(9) + String(one.p99).padStart(9) + String(one.bytes).padStart(9) + `  ${Math.round((one.perSecond / base.perSecond) * 100)}%`);
            }
            const total = (rounds + 1) * requests * 3;
            console.log(`memory, ${run.after.phpProcesses} PHP processes: ${run.started.phpRssMb} MB at start, ${run.warm.phpRssMb} MB warm, ${run.after.phpRssMb} MB after ${total} requests` + (rendering === 'server' ? `; renderer ${run.started.rendererRssMb} MB at start, ${run.warm.rendererRssMb} MB warm, ${run.after.rendererRssMb} MB after` : ''));
            console.log(`scripts sent for the page: ${Object.entries(run.scripts).map(([name, size]) => `${name} ${size} bytes`).join(', ')}`);
        } finally {
            await server.stop();
        }
    }
} finally {
    await browser.close();
}
writeFileSync(join(work, 'measurements.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nwritten to ${join(work, 'measurements.json')}`);
