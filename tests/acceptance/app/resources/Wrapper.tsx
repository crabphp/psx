import { useEffect, type ReactNode } from 'react';

/**
 * Around every page ("psx.wrapper"). Once the browser has taken the page over it says so on the
 * document, which is what a test waits for before it types or clicks: markup the server rendered
 * is on screen before anything listens to it.
 */
export default function Wrapper({ children }: { children?: ReactNode }) {
    useEffect(() => {
        document.documentElement.dataset.alive = 'yes';
    }, []);
    return <>{children}</>;
}
