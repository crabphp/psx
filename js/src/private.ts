import { createHash } from 'node:crypto';
import { existsSync, globSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * What of an application no browser is ever given as a file: anything that holds PHP, and the
 * folders that are the server's. A script may import a .psx file's component or its bindings,
 * which the compiler wrote; it may never be handed the file.
 */
export interface Boundary {
    root: string;
    /** Folders of the application that are the server's alone, as absolute paths. */
    folders: readonly string[];
}

const PHP = /\.(?:psx|php\d?|phtml|phar)$/i;
const SERVER = ['build', 'storage', 'vendor', 'config', 'database', 'app', 'routes'];

export function boundary(root: string): Boundary {
    return { root, folders: SERVER.map(folder => join(root, folder)) };
}

function within(path: string, folder: string): boolean {
    return path === folder || path.startsWith(folder + sep);
}

/** A reference without what follows its path: a query, a fragment. */
export function pathOf(reference: string): string {
    return reference.split(/[?#]/, 1)[0] ?? '';
}

/**
 * Why a file is private, or null when a browser may have it. A link is judged by what it is and
 * by what it points at: a picture's name on a PHP file does not make it a picture.
 */
export function secret(file: string, limits: Boundary): string | null {
    const seen = [file];
    try {
        seen.push(realpathSync(file));
    } catch {
        // A file that is not there holds nothing; its name is still judged.
    }
    for (const path of seen) {
        const name = path.split(sep).pop() ?? '';
        if (PHP.test(name)) {
            return 'holds PHP';
        }
        if (/^\.env(?:\..*)?$/.test(name)) {
            return 'holds the settings of the server';
        }
        for (const folder of limits.folders) {
            if (within(path, folder)) {
                return `is in ${relative(limits.root, folder)}/, which is the server's`;
            }
        }
    }
    return null;
}

export interface Reference {
    /** The reference as it was written. */
    text: string;
    /** The files it may name: one for a plain string, every match for a pattern. */
    files: string[];
}

const NEW_URL = /\bnew\s+URL\s*\(\s*('[^'\n]+'|"[^"\n]+"|`[^`]+`)\s*,\s*import\.meta\.url\s*,?\s*\)/g;
const CSS_URL = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^'")\s][^)]*?))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:'([^']+)'|"([^"]+)")/gi;
const CSS_SET = /image-set\(([^;{}]*)\)/gi;

/** Whether a module is a style sheet, by its id. */
export function styled(id: string): boolean {
    return /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss|sss)(?:$|\?)/i.test(id);
}

function candidates(written: string, bases: readonly string[], limits: Boundary): string[] {
    const path = pathOf(written);
    if (path === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(path)) {
        // An address of somewhere else, or data written in place: no file of the application.
        return [];
    }
    const forms = new Set([path]);
    try {
        forms.add(decodeURIComponent(path));
    } catch {
        // Judged as written.
    }
    const files: string[] = [];
    for (const form of forms) {
        if (isAbsolute(form)) {
            files.push(form, join(limits.root, form));
        } else {
            for (const base of bases) {
                files.push(resolve(base, form));
            }
        }
    }
    return files;
}

/**
 * The files a script names as files to be given to a browser: `new URL(..., import.meta.url)`,
 * which Vite turns into the file's address or its content without asking any plugin. A template
 * with a hole in it names every file its pattern matches, as it does for Vite.
 */
export function scriptReferences(code: string, bases: readonly string[], limits: Boundary): Reference[] {
    if (!code.includes('import.meta.url')) {
        return [];
    }
    const found: Reference[] = [];
    for (const match of code.matchAll(NEW_URL)) {
        const literal = match[1]!;
        const written = literal.slice(1, -1);
        if (literal.startsWith('`') && written.includes('${')) {
            const pattern = pathOf(written.replace(/\$\{[^}]*\}/g, '*'));
            const files: string[] = [];
            for (const base of bases) {
                const from = isAbsolute(pattern) ? limits.root : base;
                try {
                    for (const file of globSync(pattern.replace(/^\/+/, ''), { cwd: from })) {
                        files.push(resolve(from, file));
                    }
                } catch {
                    // A pattern that cannot be read matches nothing here; the bundle is looked through as well.
                }
            }
            // The pattern's own ending is judged too, should nothing match yet.
            files.push(resolve(bases[0] ?? limits.root, pattern.replace(/\*/g, 'x')));
            found.push({ text: written, files });
        } else {
            found.push({ text: written, files: candidates(written, bases, limits) });
        }
    }
    return found;
}

/** The files a style sheet names: url(), @import and image-set(). */
export function styleReferences(code: string, bases: readonly string[], limits: Boundary): Reference[] {
    const found: Reference[] = [];
    const add = (written: string | undefined): void => {
        if (written !== undefined && written.trim() !== '') {
            found.push({ text: written.trim(), files: candidates(written.trim(), bases, limits) });
        }
    };
    for (const match of code.matchAll(CSS_URL)) {
        add(match[1] ?? match[2] ?? match[3]);
    }
    for (const match of code.matchAll(CSS_IMPORT)) {
        add(match[1] ?? match[2]);
    }
    for (const match of code.matchAll(CSS_SET)) {
        for (const quoted of match[1]!.matchAll(/'([^']+)'|"([^"]+)"/g)) {
            add(quoted[1] ?? quoted[2]);
        }
    }
    return found;
}

/** The first private file among what was referred to, with why; null when all may be public. */
export function refused(
    references: readonly Reference[],
    limits: Boundary,
): { text: string; file: string; why: string } | null {
    for (const reference of references) {
        for (const file of reference.files) {
            const why = secret(file, limits);
            if (why !== null) {
                return { text: reference.text, file, why };
            }
        }
    }
    return null;
}

const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The private files of an application by the hash of their content: every file that holds PHP
 * under the application, outside what is installed or built. It is what a bundle is compared
 * with before it is written, should a file have reached it by a way nobody refused.
 */
export function privateSources(limits: Boundary, more: readonly string[] = []): Map<string, string> {
    const sources = new Map<string, string>();
    const skip = new Set(['node_modules', '.git', 'public', 'storage', 'build']);
    const walk = (folder: string, depth: number): void => {
        if (depth > 12) {
            return;
        }
        let names: string[];
        try {
            names = readdirSync(folder);
        } catch {
            return;
        }
        for (const name of names) {
            const path = join(folder, name);
            let stat;
            try {
                stat = statSync(path);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                if (!skip.has(name) && !(depth === 0 && name === 'vendor')) {
                    walk(path, depth + 1);
                }
            } else if (PHP.test(name) && stat.size > 0 && stat.size < 4 * 1024 * 1024) {
                try {
                    sources.set(digest(readFileSync(path)), path);
                } catch {
                    // Unreadable to the build is unreadable to a bundle.
                }
            }
        }
    };
    walk(limits.root, 0);
    for (const folder of more) {
        if (existsSync(folder) && !within(folder, limits.root)) {
            walk(folder, 1);
        }
    }
    return sources;
}

/** What a built file holds that it must not, or null. Encoded content is decoded before it is judged. */
export function leak(
    name: string,
    content: Uint8Array | string,
    sources: ReadonlyMap<string, string>,
): string | null {
    const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    const whole = sources.get(digest(bytes));
    if (whole !== undefined) {
        return `${name} is ${whole}, byte for byte`;
    }
    const text = bytes.toString('latin1');
    const judge = (piece: Buffer, how: string): string | null => {
        const source = sources.get(digest(piece));
        if (source !== undefined) {
            return `${name} holds ${source}, ${how}`;
        }
        if (piece.includes('<?php')) {
            return `${name} holds a PHP opening tag, ${how}`;
        }
        return piece.includes('<script lang="php">')
            ? `${name} holds the opening tag of a PHP block, ${how}`
            : null;
    };
    const plain = judge(bytes, 'as it is');
    if (plain !== null) {
        return plain;
    }
    for (const match of text.matchAll(/data:[^,;"'`\s)]*(?:;[^,;"'`\s)]+)*;base64,([A-Za-z0-9+/=_-]+)/g)) {
        const found = judge(Buffer.from(match[1]!, 'base64'), 'in a data URL');
        if (found !== null) {
            return found;
        }
    }
    for (const match of text.matchAll(/data:[^,;"'`\s)]*(?:;[^,;"'`\s)]+)*,([^"'`\s)]+)/g)) {
        let decoded: string;
        try {
            decoded = decodeURIComponent(match[1]!);
        } catch {
            continue;
        }
        const found = judge(Buffer.from(decoded, 'latin1'), 'in a data URL');
        if (found !== null) {
            return found;
        }
    }
    if (name.endsWith('.map')) {
        try {
            const map = JSON.parse(bytes.toString('utf8')) as { sources?: unknown; sourcesContent?: unknown };
            for (const source of Array.isArray(map.sources) ? map.sources : []) {
                if (typeof source === 'string' && PHP.test(pathOf(source))) {
                    return `${name} names ${source} as a source`;
                }
            }
            for (const held of Array.isArray(map.sourcesContent) ? map.sourcesContent : []) {
                if (typeof held === 'string') {
                    const found = judge(Buffer.from(held), 'in its sources');
                    if (found !== null) {
                        return found;
                    }
                }
            }
        } catch {
            // Not a map after all: judged as text above.
        }
    }
    return null;
}
