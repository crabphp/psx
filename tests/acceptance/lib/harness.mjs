// What the acceptance tests share: a clean installation of the application from the packages as they
// would be published, servers of it on ports of their own, gates, and a look into its store.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    appendFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const acceptance = resolve(here, '..');
export const psx = resolve(acceptance, '../..');
export const framework = process.env.ACCEPTANCE_FRAMEWORK ?? resolve(psx, '../framework');

/** Where this run keeps everything it makes: one folder, outside every checkout. */
export const work = process.env.ACCEPTANCE_WORK ?? mkdtempSync(join(tmpdir(), 'psx-acceptance-'));
process.env.ACCEPTANCE_WORK = work;

export async function sh(command, args, options = {}) {
    try {
        const { stdout, stderr } = await run(command, args, {
            maxBuffer: 64 * 1024 * 1024,
            ...options,
            env: { ...process.env, ...options.env },
        });
        return { code: 0, out: stdout + stderr };
    } catch (error) {
        if (typeof error.code !== 'number') {
            throw error;
        }
        return { code: error.code, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
}

async function must(command, args, options) {
    const result = await sh(command, args, options);
    if (result.code !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited ${result.code}:\n${result.out.slice(-4000)}`);
    }
    return result.out;
}

/**
 * Packs both packages as they would be published, and installs the application from those files
 * alone: nothing is linked to a checkout, so a file a package forgot to ship is missed here.
 */
export async function install() {
    const base = join(work, 'base');
    const marker = join(base, '.installed');
    const current = fingerprint();
    if (existsSync(marker) && readFileSync(marker, 'utf8') === current) {
        return base;
    }
    // The packages changed since they were packed, or never were: start from nothing.
    for (const stale of ['base', 'artifacts', 'packages']) {
        rmSync(join(work, stale), { recursive: true, force: true });
    }
    const artifacts = join(work, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    await must('npm', ['run', 'build'], { cwd: join(psx, 'js') });
    await must('npm', ['pack', '--pack-destination', artifacts], { cwd: join(psx, 'js') });
    const tarball = readdirSync(artifacts).find(name => name.endsWith('.tgz'));
    for (const [name, from] of [
        ['psx', psx],
        ['framework', framework],
    ]) {
        await must('composer', ['archive', '--format=tar', `--dir=${artifacts}`, `--file=${name}`], { cwd: from });
        const to = join(work, 'packages', name);
        mkdirSync(to, { recursive: true });
        await must('tar', ['-xf', join(artifacts, `${name}.tar`), '-C', to]);
        // What a checkout has and a release of the framework does not.
        rmSync(join(to, 'vendor'), { recursive: true, force: true });
    }
    cpSync(join(acceptance, 'app'), base, { recursive: true });
    // Each package is the version its checkout is: PSX's from its npm package, the framework's from
    // its latest tag, so a constraint such as ^0.7.5 is met as it would be by the releases.
    const versions = {
        psx: JSON.parse(readFileSync(join(psx, 'js', 'package.json'), 'utf8')).version,
        framework: execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: framework, encoding: 'utf8' })
            .trim()
            .replace(/^v/, ''),
    };
    const composer = JSON.parse(readFileSync(join(base, 'composer.json'), 'utf8'));
    composer.repositories = ['framework', 'psx'].map(name => ({
        type: 'path',
        url: `../packages/${name}`,
        options: {
            symlink: false,
            versions: { [`crabphp/${name}`]: versions[name] },
        },
    }));
    writeFileSync(join(base, 'composer.json'), JSON.stringify(composer, null, 4));
    const pack = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    pack.dependencies['@crabphp/psx'] = `file:../artifacts/${tarball}`;
    writeFileSync(join(base, 'package.json'), JSON.stringify(pack, null, 4));
    await must('composer', ['install', '--no-interaction', '--no-progress'], { cwd: base });
    await must('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: base });
    writeFileSync(marker, current);
    return base;
}

/** What the installed packages were made from: the name, size and time of every file packed. */
function fingerprint() {
    const hash = createHash('sha256');
    const walk = folder => {
        for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else if (entry.isFile()) {
                const { size, mtimeMs } = statSync(path);
                hash.update(`${path}\0${size}\0${mtimeMs}\n`);
            }
        }
    };
    for (const packed of [
        join(psx, 'src'),
        join(psx, 'composer.json'),
        join(psx, 'js', 'src'),
        join(psx, 'js', 'package.json'),
        join(framework, 'src'),
        join(framework, 'composer.json'),
        join(acceptance, 'app', 'composer.json'),
        join(acceptance, 'app', 'package.json'),
    ]) {
        if (statSync(packed).isDirectory()) {
            walk(packed);
        } else {
            const { size, mtimeMs } = statSync(packed);
            hash.update(`${packed}\0${size}\0${mtimeMs}\n`);
        }
    }
    return hash.digest('hex');
}

/** A copy of the installed application under a name, with settings of its own. */
export async function application(name, settings = {}) {
    const base = await install();
    const dir = join(work, name);
    rmSync(dir, { recursive: true, force: true });
    cpSync(base, dir, { recursive: true });
    // The fixture's own source as it is now: only the packages are cached.
    for (const authored of ['app.php', 'cua', 'config', 'resources', 'routes', 'src', 'vite.config.ts', 'tsconfig.json']) {
        rmSync(join(dir, authored), { recursive: true, force: true });
        cpSync(join(acceptance, 'app', authored), join(dir, authored), { recursive: true });
    }
    mkdirSync(join(dir, 'storage', 'gates'), { recursive: true });
    const env = { APP_DEBUG: 'false', PSX_RENDERING: 'client', ...settings };
    writeFileSync(
        join(dir, '.env'),
        Object.entries(env)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(''),
    );
    return dir;
}

export async function cua(dir, args, env = {}) {
    return sh('php', ['cua', ...args], { cwd: dir, env });
}

export async function build(dir, env = {}) {
    const result = await cua(dir, ['psx:build'], env);
    if (result.code !== 0) {
        throw new Error(`psx:build exited ${result.code}:\n${result.out.slice(-4000)}`);
    }
    return /Built release ([a-f0-9]+)/.exec(result.out)?.[1] ?? null;
}

let nextPort = Number(process.env.ACCEPTANCE_PORT ?? 8110);
export function port() {
    return nextPort++;
}

/**
 * Runs a command of the application's that serves, `start` or `dev`, and waits until it answers.
 * Its output goes to a file beside the application; stop() ends this process and no other.
 */
export async function serve(dir, options = {}) {
    const at = options.port ?? port();
    const url = `http://127.0.0.1:${at}`;
    const log = join(dir, `server-${at}.log`);
    const child = spawn('php', ['cua', options.command ?? 'start', ...(options.args ?? [])], {
        cwd: dir,
        env: {
            ...process.env,
            SERVER_ADDRESS: `tcp://127.0.0.1:${at}`,
            APP_URL: url,
            SERVER_WORKERS: String(options.workers ?? 2),
            ...options.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
    });
    let exited = null;
    child.stdout.on('data', chunk => appendFileSync(log, chunk));
    child.stderr.on('data', chunk => appendFileSync(log, chunk));
    child.on('exit', (code, signal) => {
        exited = { code, signal };
    });
    const until = Date.now() + (options.timeout ?? 60_000);
    for (;;) {
        if (exited !== null) {
            throw new Error(`The server exited ${JSON.stringify(exited)}:\n${readFileSync(log, 'utf8').slice(-4000)}`);
        }
        try {
            const response = await fetch(`${url}/up`, { signal: AbortSignal.timeout(2000) });
            if (response.ok) {
                break;
            }
        } catch {
            // Not listening yet.
        }
        if (Date.now() > until) {
            child.kill('SIGTERM');
            throw new Error(`The server did not answer in time:\n${readFileSync(log, 'utf8').slice(-4000)}`);
        }
        await pause(150);
    }
    return {
        url,
        port: at,
        dir,
        log,
        pid: child.pid,
        output: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
        exited: () => exited,
        signal: name => child.kill(name),
        async stop() {
            if (exited !== null) {
                return exited;
            }
            child.kill('SIGTERM');
            const until = Date.now() + 15_000;
            while (exited === null && Date.now() < until) {
                await pause(50);
            }
            if (exited === null) {
                child.kill('SIGKILL');
            }
            return exited;
        },
    };
}

/**
 * Starts the application in the background, as a deployment does (`php cua start --daemon`), so
 * that it can be told to reload. stop() is its own `php cua stop`.
 */
export async function daemon(dir, options = {}) {
    const at = options.port ?? port();
    const url = `http://127.0.0.1:${at}`;
    const env = {
        SERVER_ADDRESS: `tcp://127.0.0.1:${at}`,
        APP_URL: url,
        SERVER_WORKERS: String(options.workers ?? 2),
        ...options.env,
    };
    const started = await cua(dir, ['start', '--daemon'], env);
    if (started.code !== 0) {
        throw new Error(`The server did not start in the background:\n${started.out.slice(-4000)}`);
    }
    await eventually('the server to answer', async () => (await fetch(`${url}/up`, { signal: AbortSignal.timeout(2000) })).ok, options.timeout ?? 60_000);
    let stopped = false;
    return {
        url,
        port: at,
        dir,
        env,
        output: () => started.out,
        reload: () => cua(dir, ['reload'], env),
        async stop() {
            if (!stopped) {
                stopped = true;
                const result = await cua(dir, ['stop'], env);
                if (result.code !== 0) {
                    throw new Error(`The server did not stop:\n${result.out.slice(-2000)}`);
                }
            }
        },
    };
}

export const pause = ms => new Promise(done => setTimeout(done, ms));

/** Waits for something to become true, and says what it was waiting for when it does not. */
export async function eventually(what, test, timeout = 15_000) {
    const until = Date.now() + timeout;
    let last;
    for (;;) {
        try {
            last = await test();
            if (last) {
                return last;
            }
        } catch (error) {
            last = error;
        }
        if (Date.now() > until) {
            throw new Error(`Never came to pass: ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
        }
        await pause(25);
    }
}

/**
 * A gate of the application's (src/Gate.php): held, a request that reaches the place waits there.
 */
export function gate(dir, name) {
    const folder = join(dir, 'storage', 'gates');
    mkdirSync(folder, { recursive: true });
    const file = suffix => join(folder, `${name}.${suffix}`);
    const lines = suffix => (existsSync(file(suffix)) ? readFileSync(file(suffix), 'utf8').trim().split('\n') : []);
    return {
        hold() {
            rmSync(file('arrived'), { force: true });
            rmSync(file('passed'), { force: true });
            writeFileSync(file('hold'), '');
        },
        /** Until this many requests wait at the gate; gives the processes they wait in. */
        arrived: (count = 1) => eventually(`${count} at the gate ${name}`, () => (lines('arrived').length >= count ? lines('arrived') : null)),
        waiting: () => lines('arrived').length - lines('passed').length,
        async open() {
            rmSync(file('hold'), { force: true });
            const expected = lines('arrived').length;
            await eventually(`the gate ${name} to empty`, () => lines('passed').length >= expected);
        },
    };
}

/** What the application wrote down, read from its store without going through it. */
export function store(dir) {
    const file = join(dir, 'storage', 'acceptance.sqlite');
    const query = (sql, ...values) => {
        if (!existsSync(file)) {
            return [];
        }
        const db = new DatabaseSync(file, { readOnly: true });
        try {
            return db.prepare(sql).all(...values);
        } finally {
            db.close();
        }
    };
    return {
        writes: what => query('SELECT what, account, detail FROM writes WHERE what = ? ORDER BY id', what),
        count: what => query('SELECT COUNT(*) AS n FROM writes WHERE what = ?', what)[0]?.n ?? 0,
        revision: context => query('SELECT revision FROM browsers WHERE context = ?', context)[0]?.revision ?? 0,
        note: account => query('SELECT text, version FROM notes WHERE account = ?', account)[0] ?? null,
    };
}

/** Every request a page sends, as the browser sent it, for a test to count. */
export function watch(page) {
    const seen = [];
    page.on('request', request => {
        seen.push({ method: request.method(), url: new URL(request.url()).pathname + new URL(request.url()).search, headers: request.headers() });
    });
    return {
        all: () => seen,
        posts: () => seen.filter(request => request.method === 'POST'),
        reset: () => seen.splice(0, seen.length),
    };
}
