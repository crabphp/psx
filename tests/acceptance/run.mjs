// Runs the acceptance tests against a clean installation of the packages, once for each way the
// application is served: a built release rendered in the browser (csr), a built release rendered
// first by the server (ssr), and `php cua dev` (dev).
//
//   node run.mjs                     every file, csr
//   node run.mjs --mode=all          every file, csr then ssr then dev
//   node run.mjs --mode=ssr auth     the files whose name has "auth", ssr
//
// Everything it makes is under ACCEPTANCE_WORK (a new folder under the system's temporary one when
// not given); nothing is written into a checkout, and no server but its own is started or stopped.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { acceptance, install, work } from './lib/harness.mjs';

const args = process.argv.slice(2);
const asked = args.find(arg => arg.startsWith('--mode='))?.slice(7) ?? 'csr';
const modes = asked === 'all' ? ['csr', 'ssr', 'dev'] : asked.split(',');
const names = args.filter(arg => !arg.startsWith('--'));
const files = readdirSync(acceptance)
    .filter(name => name.endsWith('.test.mjs'))
    .filter(name => names.length === 0 || names.some(wanted => name.includes(wanted)))
    .sort();

console.log(`work: ${work}`);
await install();
console.log('installed from the packed packages');

const results = [];
for (const mode of modes) {
    if (!['csr', 'ssr', 'dev'].includes(mode)) {
        throw new Error(`No such mode: ${mode}`);
    }
    console.log(`\n=== ${mode} ===`);
    const code = await new Promise(done => {
        const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map(file => join(acceptance, file))], {
            cwd: acceptance,
            env: { ...process.env, ACCEPTANCE_MODE: mode, ACCEPTANCE_WORK: work },
            stdio: 'inherit',
        });
        child.on('exit', done);
    });
    results.push([mode, code]);
}
console.log(`\n${results.map(([mode, code]) => `${mode}: ${code === 0 ? 'passed' : `FAILED (${code})`}`).join('   ')}`);
process.exit(results.every(([, code]) => code === 0) ? 0 : 1);
