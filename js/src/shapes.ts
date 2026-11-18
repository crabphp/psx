import type { Shape } from './types.js';

const SAFE = Number.MAX_SAFE_INTEGER;
const DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/;

/**
 * Whether a value is what a shape says: the check the runtime makes of everything a server sent
 * before it reaches a component or a cache, and that a test's fixture is held to. It gives the
 * place of the first thing that is not, or null.
 */
export function mismatch(
    shape: Shape,
    value: unknown,
    path = 'data',
    depth = 0,
    maxDepth = 32,
): string | null {
    if (depth > maxDepth) {
        return `${path} is nested too deep`;
    }
    switch (shape.k) {
        case 'null':
            return value === null ? null : `${path} is not null`;
        case 'string':
            return typeof value === 'string' ? null : `${path} is not a string`;
        case 'date':
            return typeof value === 'string' && DATE.test(value) ? null : `${path} is not a date and time`;
        case 'bool':
            return typeof value === 'boolean' ? null : `${path} is not a boolean`;
        case 'int':
            return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= SAFE
                ? null
                : `${path} is not a whole number JavaScript holds exactly`;
        case 'float':
            return typeof value === 'number' && Number.isFinite(value)
                ? null
                : `${path} is not a finite number`;
        case 'enum':
            // A number JavaScript does not hold exactly is no enum's value, whatever the shape lists:
            // two cases of the server's would be one here.
            return (typeof value === 'string' ||
                (typeof value === 'number' && Number.isSafeInteger(value))) &&
                shape.values.includes(value)
                ? null
                : `${path} is not one of its enum's values`;
        case 'nullable':
            return value === null ? null : mismatch(shape.of, value, path, depth, maxDepth);
        case 'list': {
            if (!Array.isArray(value)) {
                return `${path} is not a list`;
            }
            for (let index = 0; index < value.length; index++) {
                const found = mismatch(shape.of, value[index], `${path}[${index}]`, depth + 1, maxDepth);
                if (found !== null) {
                    return found;
                }
            }
            return null;
        }
        case 'map': {
            if (!plain(value)) {
                return `${path} is not a map`;
            }
            for (const key of Object.keys(value)) {
                const found = mismatch(shape.of, value[key], `${path}[${key}]`, depth + 1, maxDepth);
                if (found !== null) {
                    return found;
                }
            }
            return null;
        }
        case 'object': {
            if (!plain(value)) {
                return `${path} is not an object`;
            }
            for (const key of Object.keys(value)) {
                if (!Object.hasOwn(shape.props, key)) {
                    return `${path}.${key} is not a field its type declares`;
                }
            }
            for (const key of Object.keys(shape.props)) {
                if (!Object.hasOwn(value, key)) {
                    return `${path}.${key} is missing`;
                }
                const found = mismatch(shape.props[key]!, value[key], `${path}.${key}`, depth + 1, maxDepth);
                if (found !== null) {
                    return found;
                }
            }
            return null;
        }
    }
    return `${path} has a shape this runtime does not know`;
}

export function plain(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
