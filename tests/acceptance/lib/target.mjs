// The server a test file drives: the one run.mjs started for this mode, or one of its own.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { application, build, daemon, serve } from './harness.mjs';

export const mode = process.env.ACCEPTANCE_MODE ?? 'csr';

export async function target(name, options = {}) {
    if (process.env.ACCEPTANCE_URL && !options.own) {
        return {
            url: process.env.ACCEPTANCE_URL,
            dir: process.env.ACCEPTANCE_DIR,
            mode,
            output: () => '',
            stop: async () => undefined,
        };
    }
    const dir = await application(name, {
        PSX_RENDERING: mode === 'ssr' ? 'server' : 'client',
        ...(mode === 'dev' ? { ACCEPTANCE_CSP: 'false' } : {}),
        ...options.settings,
    });
    if (mode !== 'dev') {
        await build(dir);
    }
    // Where PHP keeps a request's body while it is larger than memory should hold: a folder of this
    // application's own when asked for, so that what is left there can be counted.
    const temporary = options.temporary ? join(dir, 'storage', 'tmp') : null;
    if (temporary !== null) {
        mkdirSync(temporary, { recursive: true });
    }
    if (options.daemon) {
        return { ...(await daemon(dir, { workers: options.workers, env: options.env })), mode, temporary };
    }
    const server = await serve(dir, {
        command: mode === 'dev' ? 'dev' : 'start',
        workers: options.workers,
        env: { ...(temporary === null ? {} : { TMPDIR: temporary }), ...options.env },
        timeout: 120_000,
    });
    if (mode === 'dev') {
        await warm(server.url);
    }
    return { ...server, mode, temporary };
}

/**
 * Opens every kind of page once before the tests do. A Vite that has just started finds the
 * packages a page imports as it serves them, bundles them, and reloads the page it was serving:
 * its own business, and done with after the first loads.
 */
async function warm(url) {
    const browser = await chromium.launch();
    try {
        const page = await (await browser.newContext({ baseURL: url })).newPage();
        for (let round = 0; round < 2; round++) {
            for (const path of ['/login', '/forms', '/upload', '/boxes', '/lazy', '/long', '/fragile']) {
                await page.goto(path);
                await page.waitForLoadState('networkidle');
            }
        }
        await signIn(page, 'warm');
        for (const path of ['/other', '/t/acme', '/t/acme/members']) {
            await page.goto(path);
            await page.waitForLoadState('networkidle');
        }
    } finally {
        await browser.close();
    }
}

export async function launch() {
    return chromium.launch();
}

/** A page of a browser context, with what went wrong in it written down. */
export async function open(context, path) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // And what the application itself reports: a render that failed, markup that could not be taken over.
    page.on('console', message => {
        if (message.type() === 'error' && message.text().startsWith('psx ')) {
            errors.push(message.text());
        }
    });
    if (path !== undefined) {
        await page.goto(path);
        await alive(page);
    }
    return { page, errors };
}

/**
 * Waits until the application has taken the document over. Markup the server rendered can be seen,
 * typed into and clicked before anything listens to it; a person waits without knowing, a test has
 * to be told (resources/Wrapper.tsx says so).
 */
export async function alive(page) {
    await page.locator('html[data-alive="yes"]').waitFor({ state: 'attached' });
}

/** Signs a page in through the application's own page, as a person would. */
export async function signIn(page, account) {
    await page.goto('/login');
    await alive(page);
    await page.getByLabel('Account').fill(account);
    await page.getByLabel('Password').fill(`pw-${account}`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByTestId('home-account').filter({ hasText: account }).waitFor();
    // Signing in ends in a document of its own, or in this one shown again: alive either way.
    await alive(page);
}

/**
 * Everything the document holds: its title, what a person can read, and the whole of its markup,
 * with the data it arrived with and whatever a script could still read out of it.
 */
export async function shown(page) {
    return page.evaluate(() => `${document.title}\n${document.body.innerText}\n${document.documentElement.outerHTML}`);
}
