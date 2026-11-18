<?php

declare(strict_types=1);

namespace Crab\Psx\Tests;

use Crab\AppBuilder;
use Crab\Engine\Crab;
use Crab\Engine\EventLoop;
use Crab\Engine\Process\Worker;
use Crab\Http\HttpException;
use Crab\Psx\Commands\PsxBuild;
use Crab\Psx\PsxException;
use Crab\Psx\PsxPlugin;
use Crab\Psx\Runtime\Kernel;
use Crab\Psx\Runtime\SocketRenderer;
use Crab\Psx\Tests\Support\FakeAuth;
use Crab\Psx\Tests\Support\FakeRenderer;
use Crab\Psx\Tests\Support\FixtureApp;
use Crab\Psx\Tests\Support\Nonce;
use PHPUnit\Framework\TestCase;

/**
 * What stands around the pages: the scaffold and the console, the
 * renderer, the check that no PHP is published, and logging in and out
 * from a page.
 */
final class ToolingTest extends TestCase
{
    public function testTheScaffoldWritesAnApplicationThatCompilesAndKeepsWhatIsThere(): void
    {
        $base = sys_get_temp_dir() . '/psx-init-' . bin2hex(random_bytes(6));
        mkdir("{$base}/routes", 0o755, true);
        mkdir("{$base}/config");
        $autoload = var_export(dirname(__DIR__) . '/vendor/autoload.php', true);
        file_put_contents("{$base}/routes/web.php", "<?php\n");
        file_put_contents("{$base}/config/log.php", "<?php\nreturn ['path' => 'php://memory'];\n");
        file_put_contents(
            "{$base}/app.php",
            "<?php\nreturn Crab\\App::configure(__DIR__)->withPlugins([new Crab\\Psx\\PsxPlugin()])->withRouting(routes: 'routes/web.php')->create();\n",
        );
        file_put_contents(
            "{$base}/cua",
            "<?php\nrequire {$autoload};\nexit(Crab\\Cua::run(__DIR__ . '/app.php', array_slice(\$argv, 1)));\n",
        );
        $cua = static function (string ...$arguments) use ($base): array {
            exec(
                escapeshellarg(PHP_BINARY)
                . ' '
                . escapeshellarg("{$base}/cua")
                . ' '
                . implode(' ', array_map(escapeshellarg(...), $arguments))
                . ' 2>&1',
                $lines,
                $status,
            );
            return [$status, implode("\n", $lines)];
        };
        try {
            // Before anything is written, the pages file the plugin names is not there: only the scaffold runs.
            [$status, $said] = $cua('psx:list');
            self::assertNotSame(0, $status);
            self::assertStringContainsString('psx:init', $said);

            [$status, $said] = $cua('psx:init');
            self::assertSame(0, $status, $said);
            self::assertStringContainsString('written  routes/pages.php', $said);
            self::assertFileExists("{$base}/resources/pages/Home.psx");
            self::assertFileExists("{$base}/vite.config.ts");

            file_put_contents("{$base}/resources/styles/app.css", "/* mine */\n");
            [$status, $said] = $cua('psx:init');
            self::assertSame(0, $status, $said);
            self::assertStringContainsString('kept     resources/styles/app.css', $said);
            self::assertSame("/* mine */\n", file_get_contents("{$base}/resources/styles/app.css"));
            [, $said] = $cua('psx:init', '--force');
            self::assertStringContainsString('written  resources/styles/app.css', $said);

            [$status, $said] = $cua('psx:list');
            self::assertSame(0, $status, $said);
            self::assertStringContainsString('page home  GET /  resources/pages/Home.psx', $said);
            self::assertStringContainsString('layouts: app', $said);
            self::assertStringContainsString('action  greet()', $said);

            [$status, $said] = $cua('psx:types');
            self::assertSame(0, $status, $said);
            self::assertStringContainsString('home: route<', (string) file_get_contents("{$base}/.psx/routes.ts"));
            self::assertStringNotContainsString(
                '<?php',
                (string) file_get_contents("{$base}/.psx/client/pages/Home.psx.tsx"),
            );

            // Nothing is served without a release, and the refusal says how to get one.
            [$status, $said] = $cua('route:list');
            self::assertSame(0, $status, $said);
            [$status, $said] = $cua('start');
            self::assertNotSame(0, $status);
            self::assertStringContainsString('psx:build', $said);
        } finally {
            exec('rm -rf ' . escapeshellarg($base));
        }
    }

    public function testAPageRenderedOnTheServerCarriesItsMarkupAndTheSameData(): void
    {
        FakeRenderer::$asked = [];
        FakeRenderer::$nonces = [];
        FakeRenderer::$down = false;
        $fixture = FixtureApp::copy(['config/psx.php' => "<?php\nreturn ['rendering' => 'server'];\n"]);
        $psx = $fixture
            ->serve(static fn(AppBuilder $builder): AppBuilder => $builder->withSetup(FakeRenderer::class))
            ->withHeaders(['X-Pass' => 'group,save']);

        $document = $psx->document('/posts/7?theme=dark');
        self::assertSame(200, $document->status());
        self::assertStringContainsString(
            '<div id="app"><main data-rendered="posts.edit">rendered</main></div>',
            (string) $document->response->getBody(),
        );
        self::assertSame('server', $document->bootstrap()['rendering']);
        // The renderer is given the page's public envelope, and nothing of the request.
        self::assertCount(1, FakeRenderer::$asked);
        self::assertSame(
            ['protocol', 'build', 'kind', 'route', 'nodes', 'head', 'tags'],
            array_keys(FakeRenderer::$asked[0]),
        );
        self::assertEquals($document->bootstrap()['envelope'], json_decode(
            (string) json_encode(FakeRenderer::$asked[0]),
            true,
        ));

        // A navigation is data: nothing is rendered for it.
        $psx->navigate('/posts/7')->assertOk();
        self::assertCount(1, FakeRenderer::$asked);
        // No nonce was named for the document: the renderer is told of none.
        self::assertSame([null], FakeRenderer::$nonces);

        // A renderer that is down is an error, never a page silently rendered another way.
        FakeRenderer::$down = true;
        self::assertSame(503, $psx->document('/posts/7')->status());
    }

    public function testTheRendererIsToldTheDocumentsNonceAndNothingElseOfTheRequest(): void
    {
        FakeRenderer::$asked = [];
        FakeRenderer::$nonces = [];
        FakeRenderer::$down = false;
        $fixture = FixtureApp::copy(['config/psx.php' => "<?php\nreturn ['rendering' => 'server'];\n"]);
        $psx = $fixture->serve(static fn(AppBuilder $builder): AppBuilder => $builder
            ->withSetup(FakeRenderer::class)
            ->withMiddleware(append: [
                Nonce::class,
            ]))->withHeaders(['X-Pass' => 'group,save', 'Cookie' => 'session=private']);

        $document = $psx->withHeaders(['X-Nonce' => 'r4nd0m_Nonce-1'])->document('/posts/7');
        self::assertSame(200, $document->status());
        $html = (string) $document->response->getBody();
        self::assertSame(['r4nd0m_Nonce-1'], FakeRenderer::$nonces);
        self::assertSame(
            ['protocol', 'build', 'kind', 'route', 'nodes', 'head', 'tags'],
            array_keys(FakeRenderer::$asked[0]),
        );
        // Nothing else of the request went with it: no cookie, no header.
        self::assertStringNotContainsString('private', (string) json_encode(FakeRenderer::$asked[0]));
        self::assertStringContainsString('<div id="app"><main data-rendered="posts.edit">', $html);

        // No nonce named, none told.
        $psx->document('/posts/7');
        self::assertSame(['r4nd0m_Nonce-1', null], FakeRenderer::$nonces);
    }

    public function testAnEmptyMapStaysAnObjectInADocument(): void
    {
        $psx = FixtureApp::copy()->serve();
        $body = (string) $psx->document('/')->response->getBody();
        self::assertStringContainsString('"params":{}', $body);
        self::assertStringContainsString('"meta":{}', $body);
        self::assertStringContainsString('"tags":[]', $body);
    }

    public function testThePhpOfAPageFoundInABuiltScriptStopsTheBuild(): void
    {
        $fixture = FixtureApp::copy();
        $manifest = $fixture->compile();
        $kernel = $fixture->serve()->container()->get(Kernel::class);
        $public = "{$fixture->base}/out";
        mkdir("{$public}/assets", 0o755, true);
        file_put_contents("{$public}/assets/clean.js", 'export const greeting = "Hello";');
        self::assertSame([], PsxBuild::leaks($kernel, $manifest, $public));

        file_put_contents(
            "{$public}/assets/leaky.js",
            "const note = 'sentinel-secret-7f3a never leaves the server';\nconst SECRET_NOTE = 'sentinel-secret-7f3a never leaves the server';",
        );
        $leaks = PsxBuild::leaks($kernel, $manifest, $public);
        self::assertNotSame([], $leaks);
        self::assertStringContainsString('leaky.js', implode("\n", $leaks));
        self::assertStringContainsString('resources/pages/Posts/Edit.psx', implode("\n", $leaks));
    }

    /**
     * R1-B01: Vite writes a small file into a script as a data URL, and
     * a larger one out as a file of its own. Neither is plain text of
     * the page, and both are the page.
     */
    public function testAPageWrittenIntoAScriptInAnotherFormStopsTheBuildToo(): void
    {
        $fixture = FixtureApp::copy();
        $manifest = $fixture->compile();
        $kernel = $fixture->serve()->container()->get(Kernel::class);
        $source = $fixture->read('resources/pages/Posts/Edit.psx');
        $forms = [
            'inline.js' => 'const u = "data:application/octet-stream;base64,' . base64_encode($source) . '";',
            'percent.js' => 'const u = "data:text/plain,' . rawurlencode($source) . '";',
            'style.css' => '.a{background:url(data:text/plain;base64,' . base64_encode($source) . ')}',
            'Edit-abc123.psx' => $source,
            'renamed-abc123.bin' => $source,
            'entry.js.map' => (string) json_encode(['version' => 3, 'sources' => ['x'], 'sourcesContent' => [$source]]),
            'only-the-tag.js' => 'const u = "data:text/plain;base64,' . base64_encode("<?php\necho 1;") . '";',
            'only-the-block-tag.js' =>
                'const u = "' . rawurlencode('<script lang="php">') . '"; // <script lang="php">',
        ];
        foreach ($forms as $name => $content) {
            $public = "{$fixture->base}/out-" . md5($name);
            mkdir("{$public}/assets", 0o755, true);
            file_put_contents("{$public}/assets/picture.js", 'const u = "data:image/png;base64,iVBORw0KGgo=";');
            self::assertSame(
                [],
                PsxBuild::leaks($kernel, $manifest, $public),
                'A picture written into a script is no leak.',
            );
            file_put_contents("{$public}/assets/{$name}", $content);
            $leaks = PsxBuild::leaks($kernel, $manifest, $public);
            self::assertCount(1, $leaks, "{$name} was not found to hold the page.");
            self::assertStringContainsString($name, $leaks[0]);
            self::assertStringNotContainsString('sentinel-secret', $leaks[0]);
        }
    }

    public function testAReleaseIsNotPublishedWhenItsScriptsWereMadeOfTheServersFiles(): void
    {
        $fixture = FixtureApp::copy([
            'config/private.json' => '{"credential":"sentinel"}',
            'vendor/acme/widgets/js/package.json' => '{"name":"@acme/widgets"}',
            'vendor/acme/widgets/js/index.js' => 'export const widget = 1;',
            'vendor/acme/widgets/src/notes.json' => '{}',
            'resources/data/public.json' => '{}',
        ]);
        symlink("{$fixture->base}/config/private.json", "{$fixture->base}/resources/data/linked.json");
        mkdir("{$fixture->base}/node_modules", recursive: true);
        symlink("{$fixture->base}/vendor/acme/widgets/js", "{$fixture->base}/node_modules/widgets");
        $kernel = $fixture->serve()->container()->get(Kernel::class);
        $list = "{$fixture->base}/inputs.json";
        $judge = static function (array $files) use ($kernel, $list): array {
            file_put_contents($list, json_encode($files));
            return PsxBuild::inputs($kernel, $list);
        };

        self::assertSame(
            [],
            $judge([
                'resources/entry.ts',
                'resources/data/public.json',
                '.psx/client/pages/Home.psx.tsx',
                '.psx/server/pages/Posts/Edit.ts',
                '.psx/manifest.ts',
                'node_modules/react/index.js',
                '../shared/ui/button.tsx',
            ]),
        );
        // The list is read once and never published.
        self::assertFileDoesNotExist($list);

        $refused = $judge([
            'resources/entry.ts',
            'config/private.json',
            'build/psx/current/manifest.json',
            'storage/app/export.json',
            'app/Secrets.js',
            'routes/map.json',
            'database/seed.sql',
            '.env',
            '.env.production',
            'resources/pages/Home.psx',
            'resources/helpers.php',
            'vendor/acme/widgets/src/notes.json',
            // A package.json beside it makes nothing of vendor/ the browser's.
            'vendor/acme/widgets/js/index.js',
            'node_modules/widgets/index.js',
            'resources/data/linked.json',
        ]);
        self::assertCount(14, $refused);
        self::assertStringContainsString("vendor/acme/widgets/js/index.js is in vendor/, which is the server's", implode(
            "\n",
            $refused,
        ));
        self::assertStringContainsString('node_modules/widgets/index.js is in vendor/', implode("\n", $refused));
        self::assertStringContainsString("config/private.json is in config/, which is the server's", implode(
            "\n",
            $refused,
        ));
        self::assertStringContainsString('resources/pages/Home.psx holds PHP', implode("\n", $refused));
        self::assertStringContainsString('.env.production holds the settings of the server', implode("\n", $refused));
        // A link is judged by what it leads to.
        self::assertStringContainsString('resources/data/linked.json is in config/', implode("\n", $refused));
        self::assertStringNotContainsString('sentinel', implode("\n", $refused));

        // A build that says nothing of what it was made of is not published either.
        self::assertCount(1, PsxBuild::inputs($kernel, $list));
        file_put_contents($list, 'not json');
        self::assertCount(1, PsxBuild::inputs($kernel, $list));
    }

    public function testDevelopmentSelectsOnlyWhatAFreshProcessCanServe(): void
    {
        $fixture = FixtureApp::copy();
        $base = $fixture->base;
        $autoload = var_export(dirname(__DIR__) . '/vendor/autoload.php', true);
        file_put_contents(
            "{$base}/app.php",
            "<?php\nreturn Crab\\App::configure(__DIR__)->withPlugins([new Crab\\Psx\\PsxPlugin()])->withRouting(routes: 'routes/web.php')->create();\n",
        );
        file_put_contents(
            "{$base}/cua",
            "<?php\nrequire {$autoload};\nexit(Crab\\Cua::run(__DIR__ . '/app.php', array_slice(\$argv, 1)));\n",
        );
        $compile = static function () use ($base): array {
            exec(
                escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg("{$base}/cua") . ' psx:compile 2>&1',
                $lines,
                $status,
            );
            return [$status, implode("\n", $lines)];
        };
        $current = static fn(): string => (string) readlink("{$base}/build/psx/dev/current");
        // What the browser was given, and what the server that answers it was compiled from.
        $state = static function () use ($base, $current): array {
            $files = [];
            $iterator = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator("{$base}/.psx", \FilesystemIterator::SKIP_DOTS),
            );
            foreach ($iterator as $file) {
                $files[substr($file->getPathname(), strlen($base) + 1)] = hash_file('sha256', $file->getPathname());
            }
            ksort($files);
            // By the link's own target: PHP remembers where a path led the last time it was asked.
            return [$current(), $files, hash_file('sha256', "{$base}/build/psx/dev/{$current()}/manifest.json")];
        };
        $edit = "{$base}/resources/pages/Posts/Edit.psx";
        $web = (string) file_get_contents("{$base}/routes/web.php");
        $page = (string) file_get_contents($edit);

        [$status, $said] = $compile();
        self::assertSame(0, $status, $said);
        $good = $state();
        self::assertStringNotContainsString(
            'touched',
            (string) file_get_contents("{$base}/.psx/server/pages/Posts/Edit.ts"),
        );

        // An ordinary route takes a page's address while the page's PHP and TSX change.
        file_put_contents(
            "{$base}/routes/web.php",
            $web . "Route::get('/posts', static fn(): string => 'ordinary');\n",
        );
        file_put_contents($edit, str_replace(
            ['function touch(', 'Edit Seven'],
            ['function touched(', 'Edit 7'],
            $page,
        ));
        [$status, $said] = $compile();
        self::assertNotSame(0, $status);
        self::assertStringContainsString('GET /posts is already defined', $said);
        self::assertSame($good, $state());

        // A Server class is made with a service that needs what nothing can make.
        file_put_contents("{$base}/routes/web.php", $web);
        file_put_contents($edit, str_replace(
            ['private Posts $posts', 'function touch('],
            ['private Posts $posts, private \\Crab\\Psx\\Tests\\Support\\NeedsMissing $needs', 'function touched('],
            $page,
        ));
        [$status, $said] = $compile();
        self::assertNotSame(0, $status);
        self::assertStringContainsString('Missing\\Sessions', $said);
        self::assertSame($good, $state());
        // Nothing that was refused is left to be taken for a release.
        $kept = array_values(array_diff(scandir("{$base}/build/psx/dev") ?: [], ['.', '..']));
        $expected = [$good[0], 'current'];
        sort($kept);
        sort($expected);
        self::assertSame($expected, $kept);

        // Mended: one switch, to a server and scripts that are of one compile.
        file_put_contents($edit, str_replace('function touch(', 'function touched(', $page));
        [$status, $said] = $compile();
        self::assertSame(0, $status, $said);
        self::assertNotSame($good[0], $current());
        self::assertSame($current(), trim($said));
        self::assertStringContainsString(
            'touched',
            (string) file_get_contents("{$base}/.psx/server/pages/Posts/Edit.ts"),
        );
        $after = $state();
        [$status] = $compile();
        self::assertSame(0, $status);
        self::assertSame($after, $state());

        // A change to the TSX alone keeps the server and gives the browser the new script.
        file_put_contents($edit, str_replace(
            ['function touch(', 'useState<string>'],
            ['function touched(', 'useState<string | null>'],
            $page,
        ));
        [$status, $said] = $compile();
        self::assertSame(0, $status, $said);
        self::assertSame($after[0], $current());
        self::assertStringContainsString(
            'string | null',
            (string) file_get_contents("{$base}/.psx/client/pages/Posts/Edit.psx.tsx"),
        );
    }

    public function testAnActionThatLogsInIsRefusedOnceTheBrowserIsSomeoneElse(): void
    {
        FakeAuth::$revision = '3';
        $fixture = FixtureApp::copy([
            'config/psx.php' => "<?php\nreturn ['auth_state' => " . var_export(FakeAuth::class, true) . "];\n",
            'resources/pages/Session.psx' => <<<'PSX'
                <script lang="php">
                use Crab\Psx\Action;
                use Crab\Psx\ActionResult;

                final readonly class Server
                {
                    /** @return ActionResult<string> */
                    #[Action(auth: true)]
                    public function signIn(): ActionResult
                    {
                        \Crab\Psx\Tests\Support\FakeAuth::$revision = '4';
                        \Crab\Psx\Tests\Support\FakeAuth::$partition = 'user-7';
                        return ActionResult::ok('in')->authChanged();
                    }
                }
                </script>
                export default function Session() {
                    return null;
                }
                PSX,
        ]);
        $fixture->write('routes/pages.php', str_replace(
            "\$pages->service('/people',",
            "\$pages->page('/session', 'resources/pages/Session.psx')->name('session');\n    \$pages->service('/people',",
            $fixture->read('routes/pages.php'),
        ));
        $psx = $fixture->serve();

        // The page says who the browser is, so that its caches are of one identity.
        $page = $psx->navigate('/session')->assertOk();
        self::assertSame(
            ['context' => 'browser-1', 'revision' => '3', 'partition' => 'nobody'],
            $page->envelope['auth'],
        );

        // Without the revision the page was loaded at, or with an older one, the action never runs.
        $psx->action('session/page', 'signIn')->assertProblem(409, 'auth_transition', 'not-entered');
        $psx->action('session/page', 'signIn', headers: [
            'X-PSX-Auth-Revision' => '2',
        ])->assertProblem(409, 'auth_transition', 'not-entered');
        self::assertSame('3', FakeAuth::$revision);

        $done = $psx->action('session/page', 'signIn', headers: ['X-PSX-Auth-Revision' => '3'])->assertOk();
        self::assertTrue($done->envelope['authChanged']);
        self::assertSame('4', FakeAuth::$revision);

        // The same click from a tab that has not caught up is refused now.
        $psx->action('session/page', 'signIn', headers: [
            'X-PSX-Auth-Revision' => '3',
        ])->assertProblem(409, 'auth_transition', 'not-entered');
    }

    public function testTheRendererIsAskedOverItsSocketAndRefusesAnotherRelease(): void
    {
        $node = trim((string) shell_exec('command -v node'));
        $library = dirname(__DIR__) . '/js/dist/socket.js';
        if ($node === '' || !is_file($library)) {
            self::markTestSkipped('Node and the built npm package are needed: npm run build in js/.');
        }
        $folder = sys_get_temp_dir() . '/psx-socket-' . bin2hex(random_bytes(6));
        mkdir($folder, 0o700);
        $socket = "{$folder}/r.sock";
        $script = "{$folder}/serve.mjs";
        file_put_contents(
            $script,
            'import { listen } from '
            . json_encode("file://{$library}")
            . ";\n"
            . 'listen({ socket: '
            . json_encode($socket)
            . ", build: 'b1', render: async page => `<p>\${page.route.id}</p>` });\n",
        );
        $process = proc_open(
            [$node, $script],
            [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
        );
        self::assertIsResource($process);
        try {
            for ($waited = 0; $waited < 100 && !file_exists($socket); $waited++) {
                usleep(50_000);
            }
            $renderer = new SocketRenderer($socket, 'b1', 2.0);
            self::assertTrue($renderer->ready());
            self::assertSame('<p>home</p>', $renderer->render(['kind' => 'page', 'route' => ['id' => 'home']]));
            self::assertSame(0o600, fileperms($socket) & 0o777);

            $other = new SocketRenderer($socket, 'b2', 2.0);
            self::assertFalse($other->ready());
            try {
                $other->render(['kind' => 'page', 'route' => ['id' => 'home']]);
                self::fail('A renderer of another release rendered the page.');
            } catch (HttpException $refused) {
                self::assertSame(503, $refused->status);
            }

            $small = new SocketRenderer($socket, 'b1', 2.0, maxRequestBytes: 16);
            try {
                $small->render(['kind' => 'page', 'route' => ['id' => 'home']]);
                self::fail('A page over the limit was sent.');
            } catch (HttpException $refused) {
                self::assertSame(503, $refused->status);
            }
        } finally {
            proc_terminate($process);
            proc_close($process);
            exec('rm -rf ' . escapeshellarg($folder));
        }
        self::assertFalse(new SocketRenderer($socket, 'b1', 0.5)->ready());
    }

    public function testARendererToldToStopServesTheWorkersConnectedToItUntilTheLastHasGone(): void
    {
        $node = trim((string) shell_exec('command -v node'));
        $library = dirname(__DIR__) . '/js/dist/socket.js';
        if ($node === '' || !is_file($library)) {
            self::markTestSkipped('Node and the built npm package are needed: npm run build in js/.');
        }
        $folder = sys_get_temp_dir() . '/psx-socket-' . bin2hex(random_bytes(6));
        mkdir($folder, 0o700);
        $socket = "{$folder}/r.sock";
        $script = "{$folder}/serve.mjs";
        // As the release's own renderer does: told to stop, it retires.
        file_put_contents(
            $script,
            'import { listen, retire } from '
            . json_encode("file://{$library}")
            . ';
'
            . 'const server = listen({ socket: '
            . json_encode($socket)
            . ", build: 'b1', render: async page => `<p>\${page.route.id}</p>` });\n"
            . "process.once('SIGTERM', () => retire(server, () => process.exit(0)));\n",
        );
        $page = ['kind' => 'page', 'route' => ['id' => 'home']];
        $start = static fn() => proc_open(
            [$node, $script],
            [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
        );
        $running = static fn($process): bool => proc_get_status($process)['running'];
        $until = static function (\Closure $is): bool {
            for ($waited = 0; $waited < 100 && !$is(); $waited++) {
                usleep(50_000);
            }
            return $is();
        };
        $process = $start();
        self::assertIsResource($process);
        $again = null;
        try {
            // Nothing listens yet, or nothing of this release: it is not connected, and says so at once.
            $worker = new SocketRenderer($socket, 'b1', 2.0);
            self::assertTrue($until($worker->hold(...)));
            self::assertFalse(new SocketRenderer($socket, 'b2', 2.0)->hold());
            $second = new SocketRenderer($socket, 'b1', 2.0);
            self::assertTrue($second->hold());

            // Told to stop while two workers may still ask: it goes on rendering for them.
            proc_terminate($process, SIGTERM);
            usleep(300_000);
            self::assertTrue($running($process));
            self::assertSame('<p>home</p>', $worker->render($page));
            // One has stopped; the other is still served, by a connection made after the renderer was told.
            unset($second);
            usleep(300_000);
            self::assertTrue($running($process));
            self::assertSame('<p>home</p>', $worker->render($page));
            // The last has stopped, and lets go as a worker does: so does the renderer, and takes its socket with it.
            $worker->release();
            self::assertTrue($until(static fn(): bool => !$running($process)));
            self::assertFileDoesNotExist($socket);

            // A renderer started again knows nothing of a worker: the worker tells it when it next renders.
            $worker = new SocketRenderer($socket, 'b1', 2.0);
            $again = $start();
            self::assertTrue($until($worker->hold(...)));
            proc_terminate($again, SIGKILL);
            self::assertTrue($until(static fn(): bool => !$running($again)));
            proc_close($again);
            $again = $start();
            self::assertTrue($until(static function () use ($worker, $page): bool {
                try {
                    return $worker->render($page) === '<p>home</p>';
                } catch (HttpException) {
                    return false;
                }
            }));
            // Not at every render, while it finds none: a second apart at the least.
            usleep(1_100_000);
            self::assertSame('<p>home</p>', $worker->render($page));
            proc_terminate($again, SIGTERM);
            usleep(300_000);
            self::assertTrue($running($again));
            self::assertSame('<p>home</p>', $worker->render($page));
            unset($worker);
            self::assertTrue($until(static fn(): bool => !$running($again)));

            // With nobody connected it stops when told.
            proc_close($again);
            $again = $start();
            self::assertTrue($until(static fn(): bool => new SocketRenderer($socket, 'b1', 2.0)->ready()));
            proc_terminate($again, SIGTERM);
            self::assertTrue($until(static fn(): bool => !$running($again)));
        } finally {
            foreach ([$process, $again] as $left) {
                if (is_resource($left)) {
                    proc_terminate($left, SIGKILL);
                    proc_close($left);
                }
            }
            exec('rm -rf ' . escapeshellarg($folder));
        }
    }

    /**
     * A peer that takes the place of a renderer, and writes down what it
     * was asked. What it answers to a worker that would stay connected
     * goes by the release the worker names; a page it renders at once.
     *
     * @return array{resource, string, string, \Closure(): list<array<string, mixed>>}
     */
    private function peer(): array
    {
        $node = trim((string) shell_exec('command -v node'));
        if ($node === '') {
            self::markTestSkipped('Node is needed.');
        }
        $folder = sys_get_temp_dir() . '/psx-socket-' . bin2hex(random_bytes(6));
        mkdir($folder, 0o700);
        $socket = "{$folder}/r.sock";
        $log = "{$folder}/asked.log";
        touch($log);
        file_put_contents("{$folder}/peer.mjs", <<<'JS'
            import { appendFileSync } from 'node:fs';
            import { createServer } from 'node:net';
            const [socket, log] = process.argv.slice(2);
            const frame = answer => {
                const body = Buffer.from(JSON.stringify(answer));
                const head = Buffer.alloc(4);
                head.writeUInt32BE(body.length);
                return Buffer.concat([head, body]);
            };
            createServer(connection => {
                let got = Buffer.alloc(0);
                let answered = false;
                connection.on('error', () => {});
                connection.on('data', chunk => {
                    got = Buffer.concat([got, chunk]);
                    if (answered || got.length < 4 || got.length < 4 + got.readUInt32BE(0)) {
                        return;
                    }
                    answered = true;
                    const message = JSON.parse(got.subarray(4).toString());
                    appendFileSync(log, `${JSON.stringify({ hold: message.hold === true, ping: message.ping === true, build: message.build })}\n`);
                    if (message.hold !== true) {
                        connection.end(frame(message.ping === true ? { ok: true } : { ok: true, html: '<p>page</p>' }));
                        return;
                    }
                    const yes = frame({ ok: true });
                    if (message.build === 'drip') {
                        // All of it, and right, three bytes every fifth of a second.
                        let at = 0;
                        const timer = setInterval(() => {
                            if (at >= yes.length || connection.destroyed) {
                                clearInterval(timer);
                                return;
                            }
                            connection.write(yes.subarray(at, at + 3));
                            at += 3;
                        }, 200);
                    } else if (message.build === 'silent') {
                        // Nothing at all.
                    } else if (message.build === 'long') {
                        const head = Buffer.alloc(4);
                        head.writeUInt32BE(1_000_000);
                        connection.write(Buffer.concat([head, Buffer.from('{"ok":true}')]));
                    } else if (message.build === 'more') {
                        connection.write(Buffer.concat([yes, Buffer.from('{"ok":true}')]));
                    } else if (message.build === 'cut') {
                        connection.end(yes.subarray(0, 9));
                    } else if (message.build === 'no') {
                        connection.write(frame({ ok: false }));
                    } else {
                        connection.write(yes);
                    }
                });
            }).listen(socket);
            JS);
        $process = proc_open(
            [$node, "{$folder}/peer.mjs", $socket, $log],
            [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
        );
        self::assertIsResource($process);
        for ($waited = 0; $waited < 100 && !file_exists($socket); $waited++) {
            usleep(50_000);
        }
        self::assertFileExists($socket);
        $asked = static fn(): array => array_map(
            static fn(string $line): array => (array) json_decode($line, true),
            array_values(array_filter(explode("\n", (string) file_get_contents($log)))),
        );
        return [$process, $folder, $socket, $asked];
    }

    public function testStayingConnectedTakesAQuarterOfASecondAtTheMostWhateverTheRendererDoes(): void
    {
        [$process, $folder, $socket, $asked] = $this->peer();
        $timed = static function (\Closure $does): array {
            $from = microtime(true);
            $result = $does();
            return [$result, microtime(true) - $from];
        };
        try {
            // An answer that is right, and comes in drops; none; one that is not the one message, whole.
            foreach ([
                'drip' => 0.2,
                'silent' => 0.2,
                'long' => 0.0,
                'more' => 0.0,
                'cut' => 0.0,
                'no' => 0.0,
            ] as $build => $atLeast) {
                [$held, $took] = $timed(static fn(): bool => new SocketRenderer($socket, $build, 2.0)->hold());
                self::assertFalse($held, $build);
                self::assertGreaterThanOrEqual($atLeast, $took, $build);
                self::assertLessThan(0.4, $took, "{$build} took {$took} seconds.");
            }
            [$held, $took] = $timed(static fn(): bool => new SocketRenderer($socket, 'b1', 2.0)->hold());
            self::assertTrue($held);
            self::assertLessThan(0.2, $took);
            // In less, where it is asked for.
            [$held, $took] = $timed(static fn(): bool => new SocketRenderer($socket, 'drip', 2.0)->hold(0.05));
            self::assertFalse($held);
            self::assertLessThan(0.2, $took);

            // A page is given a tenth of a second: so is the connection made before it, and the page is rendered.
            $short = new SocketRenderer($socket, 'drip', 0.1);
            self::assertFalse($short->hold());
            usleep(1_100_000);
            $before = count($asked());
            [$html, $took] = $timed(static fn(): string => $short->render(['kind' => 'page']));
            self::assertSame('<p>page</p>', $html);
            self::assertLessThan(0.3, $took, "A page given a tenth of a second took {$took}.");
            self::assertSame([true, false], array_column(array_slice($asked(), $before), 'hold'));
        } finally {
            proc_terminate($process, SIGKILL);
            proc_close($process);
            exec('rm -rf ' . escapeshellarg($folder));
        }
    }

    public function testAWorkerThatConnectsAgainHoldsUpNothingElseItAnswers(): void
    {
        [$process, $folder, $socket, $asked] = $this->peer();
        $loop = EventLoop::current();
        try {
            $renderer = new SocketRenderer($socket, 'drip', 2.0);
            self::assertFalse($renderer->hold());
            usleep(1_100_000);
            $before = count($asked());

            // Two pages asked for at once, and something else the worker does all the while.
            $turns = [];
            $done = [];
            $from = microtime(true);
            $page = static function (string $name) use ($renderer, &$done, $from): void {
                $html = $renderer->render(['kind' => 'page']);
                $done[$name] = [$html, microtime(true) - $from];
            };
            $ticking = $loop->repeat(0.01, static function () use (&$turns, $from): void {
                $turns[] = microtime(true) - $from;
            });
            $first = new \Fiber($page);
            $second = new \Fiber($page);
            $loop->defer(static fn() => $first->start('first'));
            $loop->defer(static fn() => $second->start('second'));
            $limit = $loop->delay(3.0, $loop->stop(...));
            $watch = $loop->repeat(0.005, static function () use (&$done, $loop): void {
                if (count($done) === 2) {
                    $loop->stop();
                }
            });
            try {
                $loop->run();
            } finally {
                foreach ([$ticking, $limit, $watch] as $id) {
                    $loop->cancel($id);
                }
            }
            self::assertSame(
                ['second', 'first'],
                array_keys($done),
                'The page that did not connect was held up by the one that did.',
            );
            self::assertSame('<p>page</p>', $done['first'][0]);
            self::assertSame('<p>page</p>', $done['second'][0]);
            // The one that connects again waits its quarter of a second, and no more.
            self::assertGreaterThanOrEqual(0.2, $done['first'][1]);
            self::assertLessThan(0.45, $done['first'][1]);
            // The other is answered meanwhile, and the worker went on with the rest.
            self::assertLessThan(0.15, $done['second'][1], "The other page took {$done['second'][1]} seconds.");
            $gaps = array_map(
                static fn(float $at, float $last): float => $at - $last,
                array_slice($turns, 1),
                array_slice($turns, 0, -1),
            );
            self::assertGreaterThanOrEqual(10, count($turns));
            self::assertLessThan(0.1, max($gaps), 'The worker stood still for ' . max($gaps) . ' seconds.');
            // One of the two tried, once: not both, and not again within the second.
            self::assertSame([true, false, false], array_column(array_slice($asked(), $before), 'hold'));
            $renderer->render(['kind' => 'page']);
            self::assertCount(1, array_filter(array_column(array_slice($asked(), $before), 'hold')));
        } finally {
            proc_terminate($process, SIGKILL);
            proc_close($process);
            exec('rm -rf ' . escapeshellarg($folder));
        }
    }

    public function testARendererSomebodyElseRunsIsAskedForPagesAndNothingMore(): void
    {
        [$process, $folder, $socket, $asked] = $this->peer();
        try {
            // Made as an application that runs its renderer itself makes it: nobody asked it to stay connected.
            $renderer = new SocketRenderer($socket, 'b1', 2.0);
            self::assertTrue($renderer->ready());
            self::assertSame('<p>page</p>', $renderer->render(['kind' => 'page']));
            usleep(1_100_000);
            self::assertSame('<p>page</p>', $renderer->render(['kind' => 'page']));
            self::assertSame([], array_filter(array_column($asked(), 'hold')));

            // Asked to, it does, once; let go of, it is as it was, however long it goes on rendering.
            self::assertTrue($renderer->hold());
            self::assertTrue($renderer->hold());
            self::assertCount(1, array_filter(array_column($asked(), 'hold')));
            $renderer->release();
            usleep(1_100_000);
            self::assertSame('<p>page</p>', $renderer->render(['kind' => 'page']));
            self::assertCount(1, array_filter(array_column($asked(), 'hold')));
        } finally {
            proc_terminate($process, SIGKILL);
            proc_close($process);
            exec('rm -rf ' . escapeshellarg($folder));
        }
    }

    public function testAWorkerStartsWithTheRendererItsServerRunsOrNotAtAllAndLetsGoOfItWhenItStops(): void
    {
        $node = trim((string) shell_exec('command -v node'));
        $library = dirname(__DIR__) . '/js/dist/socket.js';
        if ($node === '' || !is_file($library)) {
            self::markTestSkipped('Node and the built npm package are needed: npm run build in js/.');
        }
        $fixture = FixtureApp::copy(['config/psx.php' => "<?php\nreturn ['rendering' => 'server'];\n"]);
        $psx = $fixture->serve()->withHeaders(['X-Pass' => 'group,save']);
        // Nothing renders yet: the page is refused, never left for the browser.
        self::assertSame(503, $psx->document('/posts/7?theme=dark')->status());
        $container = $psx->container();
        $kernel = $container->get(Kernel::class);
        $transport = $kernel->responder?->services->transport();
        self::assertInstanceOf(SocketRenderer::class, $transport);
        $socket = new \ReflectionProperty($transport, 'socket')->getValue($transport);
        $build = new \ReflectionProperty($transport, 'build')->getValue($transport);
        self::assertNull($kernel->supervised, 'A release served to test it runs no renderer.');

        $folder = sys_get_temp_dir() . '/psx-socket-' . bin2hex(random_bytes(6));
        mkdir($folder, 0o700);
        if (!is_dir(dirname($socket))) {
            mkdir(dirname($socket), 0o700, true);
        }
        file_put_contents(
            "{$folder}/serve.mjs",
            'import { listen, retire } from '
            . json_encode("file://{$library}")
            . ";\nconst server = listen({ socket: "
            . json_encode($socket)
            . ', build: '
            . json_encode($build)
            . ", render: async () => '<main>rendered</main>' });\n"
            . "process.once('SIGTERM', () => retire(server, () => process.exit(0)));\n",
        );
        $start = static fn() => proc_open(
            [$node, "{$folder}/serve.mjs"],
            [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
        );
        $running = static fn($process): bool => proc_get_status($process)['running'];
        $until = static function (\Closure $is): bool {
            for ($waited = 0; $waited < 100 && !$is(); $waited++) {
                usleep(50_000);
            }
            return $is();
        };
        $timed = static function (\Closure $does): float {
            $from = microtime(true);
            $does();
            return microtime(true) - $from;
        };
        $plugin = new PsxPlugin();
        $loop = EventLoop::current();
        $answers = new Worker(
            $loop,
            new Crab('http')->listen('tcp://127.0.0.1:0', static fn() => null),
            0,
            ['tcp' => []],
            1.0,
        );
        $other = new Worker($loop, new Crab('queue'), 0, ['tcp' => []], 1.0);
        $process = null;
        try {
            // The renderer is somebody else's to run: a worker starts without asking after it.
            self::assertLessThan(0.1, $timed(static fn() => $plugin->start($answers, $container)));
            $process = $start();
            self::assertTrue($until($transport->ready(...)));
            self::assertSame(200, $psx->document('/posts/7?theme=dark')->status());
            usleep(1_100_000);
            self::assertSame(200, $psx->document('/posts/7?theme=dark')->status());
            // And it stays theirs to stop: nothing of this worker keeps it.
            proc_terminate($process, SIGTERM);
            self::assertTrue($until(static fn(): bool => !$running($process)));
            proc_close($process);
            $process = null;

            // The server runs it, as PsxDefinition says when it does.
            $kernel->supervised = $socket;
            // A worker that answers no request has no use for it.
            self::assertLessThan(0.1, $timed(static fn() => $plugin->start($other, $container)));
            // One that does, and finds none in the time it has, does not start.
            $from = microtime(true);
            try {
                $plugin->start($answers, $container);
                self::fail('A worker started without the renderer its server runs.');
            } catch (PsxException $refused) {
                self::assertStringContainsString('did not listen within 5 seconds', $refused->getMessage());
            }
            self::assertGreaterThanOrEqual(5.0, microtime(true) - $from);
            self::assertLessThan(6.0, microtime(true) - $from);

            // With the renderer there it starts, connected; told to stop, the renderer waits for it.
            $process = $start();
            self::assertTrue($until($transport->ready(...)));
            self::assertLessThan(0.5, $timed(static fn() => $plugin->start($answers, $container)));
            proc_terminate($process, SIGTERM);
            usleep(400_000);
            self::assertTrue($running($process));
            self::assertSame(200, $psx->document('/posts/7?theme=dark')->status());
            // The worker has stopped, though its process has not ended: the renderer is let go of.
            $plugin->stop($other, $container);
            usleep(200_000);
            self::assertTrue($running($process));
            $plugin->stop($answers, $container);
            self::assertTrue($until(static fn(): bool => !$running($process)));
        } finally {
            if (is_resource($process)) {
                proc_terminate($process, SIGKILL);
                proc_close($process);
            }
            exec('rm -rf ' . escapeshellarg($folder));
        }
    }
}
