import { describe, expect, it } from 'vitest';
import { buildPath, encodeQuery } from '../src/runtime.js';
import { safeHref } from '../src/protocol.js';
import { mismatch } from '../src/shapes.js';
import type { Shape } from '../src/types.js';

const post: Shape = {
    k: 'object',
    props: {
        id: { k: 'int' },
        title: { k: 'string' },
        status: { k: 'enum', values: ['draft', 'live'] },
        published: { k: 'nullable', of: { k: 'date' } },
        tags: { k: 'list', of: { k: 'string' } },
        counts: { k: 'map', of: { k: 'int' } },
    },
};
const good = { id: 1, title: 'A', status: 'draft', published: null, tags: ['x'], counts: { a: 1 } };

describe('what the server sends is held to its declared shape', () => {
    it('takes what the shape says', () => {
        expect(mismatch(post, good)).toBeNull();
        expect(mismatch(post, { ...good, published: '2026-01-02T03:04:05.000+00:00' })).toBeNull();
    });

    it.each([
        ['a missing property', { ...good, title: undefined }],
        ['a property nobody declared', { ...good, admin: true }],
        ['a number where text is declared', { ...good, title: 7 }],
        ['a fraction where a whole number is declared', { ...good, id: 1.5 }],
        ['a whole number JavaScript cannot hold', { ...good, id: 2 ** 53 }],
        ['a case the enum does not have', { ...good, status: 'deleted' }],
        ['an object where a list is declared', { ...good, tags: { 0: 'x' } }],
        ['a list where a map is declared', { ...good, counts: [1] }],
        ['a date that is no date', { ...good, published: 'yesterday' }],
        ['null where none is allowed', { ...good, title: null }],
    ])('refuses %s', (_what, value) => {
        expect(mismatch(post, value)).toEqual(expect.any(String));
    });

    it('takes no number JavaScript cannot hold for an enum’s value, whatever the shape lists', () => {
        // As a release compiled before such cases were refused would have it: two cases, one number here.
        const huge = JSON.parse('{"k":"enum","values":[1,9007199254740992,9007199254740993]}') as Shape;
        expect(mismatch(huge, 1)).toBeNull();
        expect(mismatch(huge, JSON.parse('9007199254740993'))).toEqual(expect.any(String));
        expect(mismatch(huge, 2 ** 53)).toEqual(expect.any(String));
        expect(
            mismatch({ k: 'enum', values: [Number.MAX_SAFE_INTEGER] }, Number.MAX_SAFE_INTEGER),
        ).toBeNull();
        expect(mismatch({ k: 'enum', values: [1] }, '1')).toEqual(expect.any(String));
    });

    it('refuses what is nested deeper than the limit', () => {
        let shape: Shape = { k: 'int' };
        let value: unknown = 1;
        for (let depth = 0; depth < 40; depth++) {
            shape = { k: 'list', of: shape };
            value = [value];
        }
        expect(mismatch(shape, value, 'data', 0, 32)).toMatch(/deep/);
    });

    it('does not take a property from a prototype', () => {
        const value = Object.create({ title: 'inherited' });
        Object.assign(value, { ...good, title: undefined });
        delete value.title;
        expect(mismatch(post, value)).toEqual(expect.any(String));
    });
});

describe('addresses are built, never joined', () => {
    it('encodes path parameters', () => {
        expect(
            buildPath([{ text: '/files/' }, { name: 'name', expression: null }], { name: 'a/b c?#' }),
        ).toBe('/files/a%2Fb%20c%3F%23');
    });

    it('refuses a parameter that is missing or does not fit the route', () => {
        expect(() => buildPath([{ text: '/posts/' }, { name: 'id', expression: '\\d+' }], {})).toThrow();
        expect(() =>
            buildPath([{ text: '/posts/' }, { name: 'id', expression: '\\d+' }], { id: 'x' }),
        ).toThrow();
    });

    it('writes a query as the server reads one', () => {
        expect(
            encodeQuery({
                q: 'a b',
                on: true,
                off: false,
                page: 2,
                none: undefined,
                tags: ['x', 'y'],
                by: { name: 'asc' },
            }),
        ).toBe('q=a%20b&on=true&off=false&page=2&tags%5B%5D=x&tags%5B%5D=y&by%5Bname%5D=asc');
    });

    it('goes only to http addresses', () => {
        expect(safeHref('/posts/1')).toBe('/posts/1');
        expect(safeHref('javascript:alert(1)')).toBeNull();
        expect(safeHref('data:text/html,x')).toBeNull();
        expect(safeHref('//elsewhere.example/x')).toBeNull();
    });
});
