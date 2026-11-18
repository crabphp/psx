import { createElement, useEffect, useState, type ComponentType, type ReactNode } from 'react';

/**
 * A component only a browser can run, loaded once the page is on screen. The server and the first
 * render in the browser show the same fallback, so the page hydrates as it was sent; the module is
 * not even read on the server.
 */
export function clientOnly<P extends object>(
    load: () => Promise<{ default: ComponentType<P> }>,
    fallback: ReactNode = null,
): ComponentType<P> {
    let loaded: ComponentType<P> | null = null;
    return function ClientOnly(props: P) {
        const [Loaded, setLoaded] = useState<ComponentType<P> | null>(null);
        useEffect(() => {
            let mounted = true;
            if (loaded !== null) {
                setLoaded(() => loaded);
                return;
            }
            void load().then(module => {
                loaded = module.default;
                if (mounted) {
                    setLoaded(() => module.default);
                }
            });
            return () => {
                mounted = false;
            };
        }, []);
        return Loaded === null ? fallback : createElement(Loaded, props);
    };
}
