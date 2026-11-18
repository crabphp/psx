import { useState, type ReactNode } from 'react';
import { action, query } from '../src/bindings.js';
import { Link, useQuery, useRouter } from '../src/view.js';
import type { ActionOf, LayoutProps, Manifest, PageProps, RouteScope } from '../src/types.js';

export interface Post {
    id: number;
    title: string;
    version: number;
}

export const $savePost = action.scoped<'posts.edit/page', { title: string; version: number }, Post, 'both'>(
    'pages/Edit',
    'savePost',
);
export const $history = query.scoped<'posts.edit/page', { limit?: number }, string[]>(
    'pages/Edit',
    'history',
);
export const $search = query.direct<'people', { words: string }, string[]>(
    'components/People',
    'search',
    'people',
);

/** What the components were last given, for a test to call later, as a late callback would. */
export const seen: {
    scope?: RouteScope<'posts.edit/page'>;
    save?: ActionOf<{ title: string; version: number }, Post, 'both'>;
    layoutMounts: number;
} = { layoutMounts: 0 };

function AppLayout({ data, children }: LayoutProps<{ name: string }>): ReactNode {
    const [count, setCount] = useState(() => {
        seen.layoutMounts++;
        return 0;
    });
    const router = useRouter();
    return (
        <div>
            <header>
                {data.name} <button onClick={() => setCount(count + 1)}>count {count}</button>
                <Link href="/">Home</Link>
                <Link href="/posts/1">One</Link>
                <Link href="/posts/2">Two</Link>
                <a href="https://elsewhere.example/">Elsewhere</a>
                <span data-testid="pending">{router.pending?.href ?? ''}</span>
            </header>
            {children}
        </div>
    );
}

function Home({ data }: PageProps<{ greeting: string }>): ReactNode {
    return <h1>{data.greeting}</h1>;
}

function Edit({ data, scope }: PageProps<Post, 'posts.edit/page'>): ReactNode {
    seen.scope = scope;
    seen.save = $savePost.at(scope);
    const [draft, setDraft] = useState(data.title);
    const history = useQuery($history.at(scope), { limit: 2 });
    return (
        <main>
            <h1>Edit {data.id}</h1>
            <input aria-label="Title" value={draft} onChange={event => setDraft(event.target.value)} />
            <p data-testid="version">{data.version}</p>
            <p data-testid="history">
                {history.status === 'success' ? history.data?.join(',') : history.status}
            </p>
            <History scope={scope} />
        </main>
    );
}

/** A second reader of the same query: it shares the first one's request. */
function History({ scope }: { scope: RouteScope<'posts.edit/page'> }): ReactNode {
    const history = useQuery($history.at(scope), { limit: 2 });
    return <p data-testid="history-again">{history.data?.length ?? 'none'}</p>;
}

function EditFailed({ problem }: { problem: { message: string } }): ReactNode {
    return <p role="alert">Edit refused: {problem.message}</p>;
}

const string = { k: 'string' } as const;
const int = { k: 'int' } as const;
const post = { k: 'object', props: { id: int, title: string, version: int } } as const;

export const manifest: Manifest = {
    protocol: 1,
    navigation: 'nav1',
    wrapper: null,
    modules: {
        'layouts/App': async () => ({ default: AppLayout }),
        'pages/Home': async () => ({ default: Home }),
        'pages/Edit': async () => ({ default: Edit, RouteError: EditFailed }),
    },
    routes: {
        home: {
            path: [{ text: '/' }],
            schema: 'r-home',
            query: [],
            nodes: [
                {
                    mount: 'home/app',
                    module: 'layouts/App',
                    layout: 'app',
                    shape: { k: 'object', props: { name: string } },
                },
                {
                    mount: 'home/page',
                    module: 'pages/Home',
                    layout: null,
                    shape: { k: 'object', props: { greeting: string } },
                },
            ],
        },
        'posts.edit': {
            path: [{ text: '/posts/' }, { name: 'id', expression: null }],
            schema: 'r-edit',
            query: [],
            nodes: [
                {
                    mount: 'posts.edit/app',
                    module: 'layouts/App',
                    layout: 'app',
                    shape: { k: 'object', props: { name: string } },
                },
                { mount: 'posts.edit/page', module: 'pages/Edit', layout: null, shape: post },
            ],
        },
    },
    services: { people: { path: [{ text: '/people' }] } },
    operations: {
        'pages/Edit': {
            savePost: {
                role: 'action',
                mode: 'both',
                auth: false,
                shape: post,
                mounts: {
                    'posts.edit/page': {
                        id: 'aaaa',
                        schema: 's-save',
                        path: [
                            { text: '/posts/' },
                            { name: 'id', expression: null },
                            { text: '/_psx/a/aaaa' },
                        ],
                    },
                },
            },
            history: {
                role: 'query',
                mode: 'both',
                auth: false,
                shape: { k: 'list', of: string },
                mounts: {
                    'posts.edit/page': {
                        id: 'bbbb',
                        schema: 's-history',
                        path: [
                            { text: '/posts/' },
                            { name: 'id', expression: null },
                            { text: '/_psx/q/bbbb' },
                        ],
                    },
                },
            },
        },
        'components/People': {
            search: {
                role: 'query',
                mode: 'both',
                auth: false,
                shape: { k: 'list', of: string },
                mounts: {
                    people: { id: 'cccc', schema: 's-search', path: [{ text: '/people/_psx/q/cccc' }] },
                },
            },
        },
    },
};

export const posts: Record<string, Post> = {
    '1': { id: 1, title: 'First', version: 1 },
    '2': { id: 2, title: 'Second', version: 1 },
};
