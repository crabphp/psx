<?php

declare(strict_types=1);

namespace Crab\Psx\Commands;

use Crab\Contracts\Console\Command;
use Crab\Contracts\Console\Input;
use Crab\Contracts\Console\Output;
use Crab\Psx\Runtime\Kernel;

/**
 * Writes a first page, its layout and what builds them: the pages
 * file, the entry, the Vite and TypeScript settings. A file that is
 * already there is left as it is unless --force says to replace it.
 */
final readonly class PsxInit implements Command
{
    public function __construct(
        private Kernel $kernel,
    ) {}

    public function description(): string
    {
        return 'Write a first page, a layout and the build settings (--force replaces files)';
    }

    public function handle(Input $input, Output $output): int
    {
        $force = $input->flag('force');
        $kept = 0;
        foreach (self::files() as $file => $content) {
            $path = $this->kernel->path($file);
            if (is_file($path) && !$force) {
                $output->line("kept     {$file}");
                $kept++;
                continue;
            }
            if (!is_dir(dirname($path))) {
                mkdir(dirname($path), 0o755, true);
            }
            file_put_contents($path, $content);
            $output->line("written  {$file}");
        }
        if ($kept > 0) {
            $output->line('Files that were already there are kept; --force replaces them.');
        }
        $output->line('');
        $output->line('Next:');
        $output->line('  npm install');
        $output->line('  keep .psx/, build/, node_modules/ and public/assets/psx/ out of version control');
        $output->line('  php cua dev');
        return 0;
    }

    /**
     * @return array<string, string>
     */
    private static function files(): array
    {
        return [
            'routes/pages.php' => <<<'PHP'
                <?php

                declare(strict_types=1);

                use Crab\Psx\Contracts\Pages;

                // Every page, layout and service is declared here: a file in resources/ is none of them until it is.
                return static function (Pages $pages): void {
                    $pages->layout('app', 'resources/layouts/App.psx');

                    $pages->page('/', 'resources/pages/Home.psx')->name('home')->layout('app');
                };

                PHP,
            'config/psx.php' => <<<'PHP'
                <?php

                declare(strict_types=1);

                return [
                    // "client" renders in the browser and needs no Node in production; "server" also renders the
                    // first HTML with the renderer `php cua psx:build` builds and the server starts.
                    'rendering' => env('PSX_RENDERING', 'client'),

                    // The public address of the built scripts and styles, under the public folder.
                    'assets' => '/assets/psx/',
                ];

                PHP,
            'resources/entry.tsx' => <<<'TSX'
                import { start } from '@crabphp/psx';
                import './styles/app.css';

                start({ root: document.getElementById('app')! });

                TSX,
            'resources/styles/app.css' => <<<'CSS'
                :root {
                    color-scheme: light dark;
                    font-family: system-ui, sans-serif;
                    line-height: 1.5;
                }

                body {
                    margin: 0 auto;
                    max-width: 44rem;
                    padding: 1.5rem;
                }

                CSS,
            'resources/layouts/App.psx' => <<<'PSX'
                <script lang="php">
                final readonly class Shell
                {
                    public function __construct(
                        public string $name,
                    ) {}
                }

                final readonly class Server
                {
                    public function load(): Shell
                    {
                        return new Shell((string) config('app.name', 'Crab'));
                    }
                }
                </script>
                import { Link } from '@crabphp/psx';
                import { routes } from '@psx/routes';
                import type { Props } from '@psx/types/layouts/App';

                export default function App({ data, children }: Props) {
                    return (
                        <>
                            <header>
                                <Link href={routes.home({})}>{data.name}</Link>
                            </header>
                            <main>{children}</main>
                        </>
                    );
                }

                PSX,
            'resources/pages/Home.psx' => <<<'PSX'
                <script lang="php">
                use Crab\Psx\Action;
                use Crab\Psx\Head;
                use Crab\Psx\PageData;
                use Crab\Validation\Length;

                final readonly class Home
                {
                    public function __construct(
                        public string $greeting,
                    ) {}
                }

                final readonly class Greet
                {
                    public function __construct(
                        #[Length(min: 1, max: 40)]
                        public string $name,
                    ) {}
                }

                final readonly class Server
                {
                    /** @return PageData<Home> */
                    public function load(): PageData
                    {
                        return PageData::of(new Home('Hello from PHP ' . PHP_VERSION))->head(Head::title('Home'));
                    }

                    #[Action]
                    public function greet(Greet $input): string
                    {
                        return "Hello, {$input->name}.";
                    }
                }
                </script>
                import { useState } from 'react';
                import type { Props } from '@psx/types/pages/Home';

                export default function HomePage({ data, scope }: Props) {
                    const [name, setName] = useState('');
                    const [said, setSaid] = useState('');
                    const greet = $greet.at(scope);

                    async function submit() {
                        const result = await greet({ name });
                        setSaid(result.ok ? result.data : (result.problem.fields.name?.[0] ?? result.problem.message));
                    }

                    return (
                        <>
                            <h1>{data.greeting}</h1>
                            <form action={submit}>
                                <label>
                                    Your name <input value={name} onChange={event => setName(event.target.value)} />
                                </label>
                                <button>Greet</button>
                            </form>
                            <p role="status">{said}</p>
                        </>
                    );
                }

                PSX,
            'vite.config.ts' => <<<'TS'
                import { defineConfig } from 'vite';
                import { psx } from '@crabphp/psx/vite';

                export default defineConfig({ plugins: [psx()] });

                TS,
            'tsconfig.json' => <<<'JSON'
                {
                    "compilerOptions": {
                        "target": "ES2022",
                        "module": "ESNext",
                        "moduleResolution": "Bundler",
                        "lib": ["ES2023", "DOM", "DOM.Iterable"],
                        "jsx": "react-jsx",
                        "strict": true,
                        "noEmit": true,
                        "skipLibCheck": true,
                        "isolatedModules": true,
                        "allowArbitraryExtensions": true,
                        "types": ["vite/client"],
                        "rootDirs": ["resources", ".psx/client"],
                        "paths": {
                            "@psx/*": ["./.psx/*"]
                        }
                    },
                    "include": ["resources", ".psx/**/*.ts", ".psx/**/*.tsx"]
                }

                JSON,
            'package.json' => <<<'JSON'
                {
                    "private": true,
                    "type": "module",
                    "dependencies": {
                        "@crabphp/psx": "^0.1.0",
                        "react": "^19.2.0",
                        "react-dom": "^19.2.0"
                    },
                    "devDependencies": {
                        "@types/react": "^19.2.0",
                        "@types/react-dom": "^19.2.0",
                        "typescript": "^7.0.0",
                        "vite": "^8.0.0"
                    }
                }

                JSON,
        ];
    }
}
