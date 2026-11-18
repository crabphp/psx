import { start } from '@crabphp/psx';

const app = start({
    root: document.getElementById('app')!,
    // Whatever the application reports is said where a test listens for it: nothing is put up with quietly.
    onError: (error, context) => console.error(`psx ${context.kind}: ${error.message}`),
});
// For a test to ask of the application what a person has no way to ask before the page has started.
Object.assign(window, { psx: app });
