<?php

declare(strict_types=1);

namespace Crab\Psx\Tests;

use Crab\Psx\Compiler\Source;
use Crab\Psx\PsxException;
use Crab\Psx\Tests\Support\FixtureApp;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * What the compiler writes for the server and for the browser, and
 * what it refuses, saying where.
 */
final class CompilerTest extends TestCase
{
    public function testThePhpAndTheTsxKeepTheirLinesAndNeitherHoldsTheOther(): void
    {
        $fixture = FixtureApp::copy();
        $manifest = $fixture->compile();
        $source = $fixture->read('resources/pages/Posts/Edit.psx');
        $tsx = $fixture->read('.psx/client/pages/Posts/Edit.psx.tsx');
        $php = (string) file_get_contents("{$fixture->stage}/php/pages/Posts/Edit.php");
        $lines = explode("\n", $source);

        self::assertSame(count($lines), count(explode("\n", $tsx)));
        // The closing tag inside a PHP string did not end the region, and a TSX generic did not start one.
        $at = array_search('export default function Edit({ data, scope }: Props) {', $lines, true);
        self::assertSame($lines[$at], explode("\n", $tsx)[$at]);
        self::assertStringContainsString('useState<string>', $tsx);
        self::assertStringStartsWith(
            "import { \$savePost, \$touch, \$explode, \$history, \$broken } from '@psx/server/pages/Posts/Edit';\n",
            $tsx,
        );
        self::assertStringNotContainsString('sentinel-secret', $tsx);
        self::assertStringNotContainsString('<?php', $tsx);
        self::assertStringNotContainsString('Posts $posts', $tsx);
        $load = array_search(
            '    public function load(int $id, #[FromQuery] string $tab = \'main\'): PageData|Failure|Redirect',
            $lines,
            true,
        );
        self::assertSame($lines[$load], explode("\n", $php)[$load]);
        self::assertStringNotContainsString('useState', $php);
        self::assertStringStartsWith(
            "<?php declare(strict_types=1); namespace {$fixture->namespace}\\pages\\Posts\\Edit;",
            $php,
        );
        self::assertSame(
            "{$fixture->namespace}\\pages\\Posts\\Edit\\Server",
            $manifest['modules']['resources/pages/Posts/Edit.psx']['class'],
        );
    }

    public function testNothingWrittenForTheBrowserHoldsThePhp(): void
    {
        $fixture = FixtureApp::copy();
        $fixture->compile();
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator("{$fixture->base}/.psx", \FilesystemIterator::SKIP_DOTS),
        );
        $read = 0;
        foreach ($iterator as $file) {
            $content = (string) file_get_contents($file->getPathname());
            ++$read;
            foreach ([
                'sentinel-secret',
                '<?php',
                $fixture->namespace,
                'Crab\\Psx\\Tests',
                'private Posts',
                'It broke after',
            ] as $private) {
                self::assertStringNotContainsString($private, $content, "{$file->getPathname()} holds \"{$private}\".");
            }
        }
        self::assertGreaterThan(10, $read);
    }

    public function testTheTypesAreWhatThePhpDeclares(): void
    {
        $fixture = FixtureApp::copy();
        $fixture->compile();
        $types = $fixture->read('.psx/types/pages/Posts/Edit.ts');

        self::assertStringContainsString('export type Mounts = "posts.edit/page";', $types);
        self::assertStringContainsString('export type Props = PageProps<Data, Mounts>;', $types);
        self::assertStringContainsString('    readonly status: "draft" | "live";', $types);
        self::assertStringContainsString('    readonly published: string | null;', $types);
        self::assertStringContainsString(
            "export type SavePostInput = {\n    title: string;\n    version: number;\n    note?: string | null;\n};",
            $types,
        );
        self::assertStringContainsString('export type TouchOutput = null;', $types);
        self::assertStringContainsString(
            'export type HistoryInput = {' . "\n" . '    limit?: number;' . "\n};",
            $types,
        );
        self::assertStringNotContainsString('any', $types);
        self::assertStringContainsString(
            'export type Props = LayoutProps<Data, Mounts>;',
            $fixture->read('.psx/types/layouts/App.ts'),
        );
        self::assertStringContainsString(
            '"posts.edit/app" | "posts.index/app"',
            $fixture->read('.psx/types/layouts/App.ts'),
        );
        // A service mounted twice is called through a scope; the routes take the query of every loader of the chain.
        self::assertStringContainsString('query.scoped<', $fixture->read('.psx/server/components/People.ts'));
        self::assertStringContainsString(
            'edit: route<{ id: number }, { theme?: string; tab?: string }>("posts.edit"',
            $fixture->read('.psx/routes.ts'),
        );
        self::assertStringContainsString(
            'orgPeople: service<{ org: string | number }, "orgPeople">',
            $fixture->read('.psx/services.ts'),
        );
    }

    public function testPagesAreDeclaredInTheRouteFileWithShortNames(): void
    {
        $fixture = FixtureApp::copy([
            'routes/pages.php' => null,
            'routes/web.php' => <<<'PHP'
                <?php

                declare(strict_types=1);

                use Crab\Psx\Psx;
                use Crab\Route;

                Route::get('/plain', static fn(): array => ['plain' => true]);

                Psx::layout('app', 'App');
                Psx::page('/', 'Home')->name('home');
                Psx::prefix('/blog')->group(function (): void {
                    Psx::page('/posts', 'Posts/Index')->name('posts.index')->layout('app');
                    Psx::page('/posts/{id}', 'Posts/Edit')->name('posts.edit')->layout('app');
                });
                Psx::service('/people', 'resources/components/People.psx')->name('people');

                PHP,
        ]);
        $fixture->compile();
        $psx = $fixture->serve();
        $kernel = $psx->container()->get(\Crab\Psx\Runtime\Kernel::class);

        self::assertSame(
            [
                'resources/layouts/App.psx',
                'resources/pages/Home.psx',
                'resources/pages/Posts/Index.psx',
                'resources/pages/Posts/Edit.psx',
                'resources/components/People.psx',
            ],
            array_map(static fn($declaration): string => $declaration->file, $kernel->registry->all()),
        );
        $psx->navigate('/')->assertOk();
        $psx->navigate('/blog/posts')->assertOk();
        self::assertSame('Seven', $psx->navigate('/blog/posts/7')->assertOk()->data(1)['post']['title']);
        self::assertSame(
            ['plain' => true],
            json_decode((string) $psx->send(new \Crab\Http\Request('GET', '/plain'))->response->getBody(), true),
        );
    }

    public function testAShortNameIsAFileOfItsKindOrRefused(): void
    {
        foreach ([
            "Psx::page('/x', 'Nope');" => 'resources/pages/Nope.psx: The page names a file that does not exist.',
            "Psx::page('/x', '../Home');" => 'or by its name in the folder of its kind',
            "Psx::layout('side', 'Home');" => 'resources/layouts/Home.psx: The layout names a file that does not exist.',
        ] as $line => $refusal) {
            $fixture = FixtureApp::copy([
                'routes/web.php' => "<?php\nuse Crab\\Psx\\Psx;\n{$line}\n",
            ]);
            try {
                $fixture->compile();
                self::fail("{$line} was let through.");
            } catch (PsxException $refused) {
                self::assertStringContainsString($refusal, $refused->getMessage());
            }
        }
    }

    public function testPsxWithoutItsPluginSaysWhatIsMissing(): void
    {
        $fixture = FixtureApp::copy(['routes/web.php' => "<?php\nCrab\\Psx\\Psx::page('/', 'Home');\n"]);

        $this->expectException(PsxException::class);
        $this->expectExceptionMessage('the application has no PsxPlugin');
        \Crab\App::configure($fixture->base)->withRouting(routes: 'routes/web.php')->create();
    }

    public function testTwoFilesWithTheSameNamesDoNotMeet(): void
    {
        $fixture = FixtureApp::copy([
            'resources/pages/Other.psx' =>
                "<script lang=\"php\">\nfinal readonly class EditData { public function __construct(public string \$other) {} }\n"
                    . "function view(): string { return 'other'; }\n"
                    . "final readonly class Server { public function load(): EditData { return new EditData(view()); } }\n</script>\nexport default function Other() { return null; }\n",
            'routes/more.php' => "<?php\nreturn static function (\$pages): void { \$pages->page('/other', 'resources/pages/Other.psx')->name('other'); };\n",
        ]);
        $fixture->write('routes/pages.php', str_replace(
            "\$pages->service('/people'",
            "(require __DIR__ . '/more.php')(\$pages);\n    \$pages->service('/people'",
            $fixture->read('routes/pages.php'),
        ));

        $psx = $fixture->serve()->withHeaders(['X-Pass' => 'group']);

        self::assertSame(['other' => 'other'], $psx->navigate('/other')->assertOk()->data(0));
        self::assertSame('Seven', $psx->navigate('/posts/7')->assertOk()->data(1)['post']['title']);
    }

    public function testACompileIsTheSameEachTimeAndChangesWithThePhpAlone(): void
    {
        $fixture = FixtureApp::copy();
        $first = $fixture->compile()['build'];
        $written = filemtime("{$fixture->base}/.psx/routes.ts");

        $again = FixtureApp::copy(namespace: $fixture->namespace . 'a');
        $same = $again->compile()['build'];
        $tsx = FixtureApp::copy(namespace: $fixture->namespace . 'a');
        $tsx->write(
            'resources/pages/Home.psx',
            "export default function Home() {\n    return <main>Changed</main>;\n}\n",
        );
        $php = FixtureApp::copy(namespace: $fixture->namespace . 'a');
        $php->write('resources/components/People.psx', str_replace(
            'Lovelace',
            'Hopper',
            $php->read('resources/components/People.psx'),
        ));
        // Each folder is loaded by a process of its own: a process compiles a namespace once.
        $build = static fn(FixtureApp $app): string => trim((string) shell_exec(
            escapeshellarg(PHP_BINARY)
                . ' '
                . escapeshellarg(dirname(__DIR__) . '/tests/Support/compile.php')
                . ' '
                . escapeshellarg($app->base)
                . ' '
                . escapeshellarg($app->namespace),
        ));

        self::assertMatchesRegularExpression('/^[0-9a-f]{16}$/', $first);
        self::assertSame($written, filemtime("{$fixture->base}/.psx/routes.ts"));
        self::assertSame($same, $build($tsx));
        self::assertNotSame($same, $build($php));
        self::assertNotSame($first, $same);
        self::assertStringContainsString('Changed', $tsx->read('.psx/client/pages/Home.psx.tsx'));
    }

    /**
     * @param array<string, string|null> $files
     */
    #[DataProvider('refused')]
    public function testAMistakeIsRefusedWithItsFileAndLine(array $files, string $message): void
    {
        $fixture = FixtureApp::copy($files);

        try {
            $fixture->compile();
            $fixture->serve();
            self::fail('It was compiled.');
        } catch (PsxException $refused) {
            self::assertStringContainsString($message, $refused->getMessage());
        }
    }

    /**
     * @return iterable<string, array{array<string, string>, string}>
     */
    public static function refused(): iterable
    {
        $page = static fn(string $php, string $tsx = "export default function Home() { return null; }\n"): array => [
            'resources/pages/Home.psx' => "<script lang=\"php\">\n{$php}\n</script>\n{$tsx}",
        ];
        $server =
            static fn(string $methods): string => "use Crab\\Psx\\Action;\nuse Crab\\Psx\\Query;\nuse Crab\\Psx\\PageData;\nuse Crab\\Psx\\ActionResult;\nuse Crab\\Psx\\Failure;\nfinal readonly class Server\n{\n{$methods}\n}";

        yield 'a statement that runs' => [
            $page('echo "hello";'),
            'resources/pages/Home.psx:2: The PHP block holds imports, constants, functions and types',
        ];
        yield 'a namespace' => [
            $page('namespace App;'),
            'resources/pages/Home.psx:2: A .psx file declares no namespace',
        ];
        yield 'another strictness' => [
            $page('declare(strict_types=0);'),
            'declare(strict_types=1); it cannot declare anything else',
        ];
        yield 'a block never closed' => [
            ['resources/pages/Home.psx' => "<script lang=\"php\">\nfinal readonly class Server {}\n"],
            'The PHP block is not closed',
        ];
        yield 'php after the block' => [
            $page('', "const a = '<?php echo 1 ?>';\n"),
            'There is PHP after the "</script>"',
        ];
        yield 'a second php block' => [
            $page('', "const a = 1;\n<script lang=\"php\">\n</script>\n"),
            'resources/pages/Home.psx:5: There is PHP after the "</script>"',
        ];
        yield 'php not first' => [
            ['resources/pages/Home.psx' => "import x from 'y';\n<script lang=\"php\">\n</script>\n"],
            'resources/pages/Home.psx:2: The PHP block must be the first thing',
        ];
        yield 'a block with other attributes' => [
            ['resources/pages/Home.psx' => "<script lang=\"php\" setup>\n</script>\n"],
            'resources/pages/Home.psx:1: The PHP block must be the first thing',
        ];
        yield 'the old open tag' => [
            ['resources/pages/Home.psx' => "<?php\nfinal readonly class Server {}\n?>\nexport default 1;\n"],
            'resources/pages/Home.psx:1: The PHP of a .psx file is written in a <script lang="php"> block',
        ];
        yield 'a close tag in the block' => [
            $page("const A = 1;\n?>"),
            'resources/pages/Home.psx:3: The PHP block holds a "?>"',
        ];
        yield 'tsx on the line of the end tag' => [
            ['resources/pages/Home.psx' => "<script lang=\"php\">\nconst A = 1;\n</script> export default 1;\n"],
            'resources/pages/Home.psx:3: The TSX starts on the line after the </script>',
        ];
        yield 'a Server that is not readonly' => [
            $page('final class Server {}'),
            'declared "final readonly class Server"',
        ];
        yield 'a syntax error' => [
            $page("final readonly class Server {\n    public function load( {}\n}"),
            'resources/pages/Home.psx:3: ',
        ];
        yield 'an unmarked public method' => [
            $page($server('    public function helper(): int { return 1; }')),
            'resources/pages/Home.psx:9: helper() is public and marked neither',
        ];
        yield 'both a query and an action' => [
            $page($server("    #[Query]\n    #[Action]\n    public function both(): int { return 1; }")),
            'marked both #[Query] and #[Action]',
        ];
        yield 'a marked load' => [
            $page($server("    #[Query]\n    public function load(): int { return 1; }")),
            'load() is the page\'s loader',
        ];
        yield 'no return type' => [
            $page($server("    #[Query]\n    public function find() { return 1; }")),
            'find() declares no return type',
        ];
        yield 'an array nobody described' => [
            $page($server("    #[Query]\n    public function find(): array { return []; }")),
            'is an array, which does not say what it holds',
        ];
        yield 'mixed' => [
            $page($server("    #[Query]\n    public function find(): mixed { return 1; }")),
            'is mixed, which does not say what the page receives',
        ];
        yield 'a loader of a scalar' => [
            $page($server('    public function load(): int { return 1; }')),
            'load() returns the page\'s props',
        ];
        yield 'a wrapper without its type' => [
            $page($server('    public function load(): PageData { return PageData::of(null); }')),
            'has no docblock saying of what',
        ];
        yield 'a docblock that disagrees' => [
            $page($server(
                "    /** @return PageData<Failure>|Failure */\n    public function load(): PageData { return PageData::of(null); }",
            )),
            'docblock and its return type disagree',
        ];
        yield 'an action with a bare failure' => [
            $page($server("    #[Action]\n    public function save(): int|Failure { return 1; }")),
            'Return an ActionResult',
        ];
        yield 'a model for an output' => [
            $page(
                "final class Model { public string \$name = ''; }\n"
                    . $server("    #[Query]\n    public function find(): Model { return new Model(); }"),
            ),
            'is not readonly',
        ];
        yield 'an output that holds itself' => [
            $page(
                "final readonly class Node { public function __construct(public ?Node \$next) {} }\n"
                    . $server("    #[Query]\n    public function find(): Node { return new Node(null); }"),
            ),
            'which holds itself',
        ];
        yield 'an unbacked enum' => [
            $page(
                "enum Kind { case A; }\n"
                    . $server("    #[Query]\n    public function find(): Kind { return Kind::A; }"),
            ),
            'has no backing values',
        ];
        yield 'a static method' => [
            $page($server("    #[Query]\n    public static function find(): int { return 1; }")),
            'find() is static',
        ];
        yield 'magic dispatch' => [
            $page($server('    public function __call(string $name, array $arguments): mixed { return 1; }')),
            'has __call()',
        ];
        yield 'a binding the tsx declares' => [
            $page(
                $server("    #[Query]\n    public function find(): int { return 1; }"),
                "const \$find = 1;\nexport default function Home() { return null; }\n",
            ),
            'resources/pages/Home.psx:13: The TSX declares $find',
        ];
        yield 'an action that reads the query' => [
            $page(
                "use Crab\\Routing\\FromQuery;\n"
                    . $server("    #[Action]\n    public function save(#[FromQuery] string \$mode): int { return 1; }"),
            ),
            'The action save() reads the query string',
        ];
        yield 'a query with a body' => [
            $page(
                "final readonly class Body { public function __construct(public string \$a) {} }\n"
                    . $server("    #[Query]\n    public function find(Body \$body): int { return 1; }"),
            ),
            'as its body, and a GET request has none',
        ];
        yield 'a path parameter the path lacks' => [
            $page($server('    public function load(int $id): ?Failure { return null; }')),
            'resources/pages/Home.psx',
        ];
        yield 'a server nobody declared' => [
            [
                'resources/components/Stray.psx' => "<script lang=\"php\">\nfinal readonly class Server {}\n</script>\nexport default function Stray() { return null; }\n",
            ],
            'resources/components/Stray.psx: The file has a Server class and is not declared',
        ];
        $pages = static fn(string $body): array => [
            'routes/pages.php' => "<?php\nreturn static function (\$pages): void {\n{$body}\n};\n",
            'resources/components/People.psx' => null,
            'resources/pages/Posts/Edit.psx' => null,
            'resources/pages/Posts/Index.psx' => null,
            ...(str_contains($body, 'layouts/App.psx') ? [] : ['resources/layouts/App.psx' => null]),
        ];
        $files = "<script lang=\"php\">\nuse Crab\\Psx\\Query;\nfinal readonly class Listing { public function __construct(public string \$tail) {} }\nfinal readonly class Server\n{\n    public function load(string \$tail): Listing { return new Listing(\$tail); }\n    #[Query]\n    public function ping(string \$tail): string { return \"pong:{\$tail}\"; }\n}\n</script>\nexport default function Files() { return null; }\n";
        foreach ([
            'every segment' => '{tail:.+}',
            'every segment, lazily' => '{tail:.*?}',
            'segments of letters and slashes' => '{tail:[a-z0-9_/]+}',
            // What trying a handful of addresses did not find.
            'segments under a first of its own' => '{tail:x/.+}',
            'anything but a space' => '{tail:\S+}',
            'a range that holds the slash' => '{tail:[.-a]+}',
            'anything that is not a digit' => '{tail:[^0-9]+}',
        ] as $what => $parameter) {
            yield "a page whose last parameter takes {$what}, with a query" => [
                [
                    ...$pages("    \$pages->page('/files/{$parameter}', 'resources/pages/Files.psx')->name('files');"),
                    'resources/pages/Files.psx' => $files,
                ],
                'takes every segment after it, and so the address of the query ping() (resources/pages/Files.psx)',
            ];
        }
        $twin =
            static fn(string $name): string => "<script lang=\"php\">\nfinal readonly class Data { public function __construct(public int \$n = 1) {} }\nfinal readonly class Server\n{\n    public function load(): Data { return new Data(); }\n}\n</script>\nexport default function {$name}() { return null; }\n";
        foreach ([
            'punctuation' => ['foo-bar', 'foo_bar'],
            'a leading digit' => ['1up', '_1up'],
            'case' => ['Foo', 'foo'],
        ] as $what => [$one, $other]) {
            yield "two files that differ only by {$what}" => [
                [
                    ...$pages(
                        "    \$pages->page('/one', 'resources/pages/{$one}.psx')->name('one');\n    \$pages->page('/other', 'resources/pages/{$other}.psx')->name('other');",
                    ),
                    "resources/pages/{$one}.psx" => $twin('One'),
                    "resources/pages/{$other}.psx" => $twin('Other'),
                ],
                'are the same to PHP: both compile into the namespace',
            ];
        }
        $big = "enum Big: int\n{\n    case Small = 1;\n    case Edge = 9007199254740991;\n    case Big = BIG;\n}\n";
        $taking = static fn(
            string $parameter,
            string $more = '',
        ): string => "use Crab\\Psx\\Action;\nuse Crab\\Psx\\Query;\nuse Crab\\Routing\\FromQuery;\nuse Crab\\Validation\\ListOf;\n{$more}final readonly class Server\n{\n    #[Action]\n    public function choose({$parameter}): int { return 1; }\n}";
        foreach ([
            'a field of its input' => [
                'Choice $choice',
                "final readonly class Choice { public function __construct(public ?Big \$size = null) {} }\n",
            ],
            'a list in its input' => [
                'Choice $choice',
                "final readonly class Choice { public function __construct(#[ListOf(Big::class)] public array \$sizes = []) {} }\n",
            ],
            'an input inside its input' => [
                'Outer $outer',
                "final readonly class Inner { public function __construct(public Big \$size) {} }\nfinal readonly class Outer { public function __construct(public Inner \$inner) {} }\n",
            ],
        ] as $what => [$parameter, $more]) {
            foreach (['9007199254740993', '-9007199254740992'] as $value) {
                yield "an enum past what a browser holds, {$value}, as {$what}" => [
                    $page(str_replace('BIG', $value, $big) . $taking($parameter, $more)),
                    "choose() takes an enum with the value {$value}",
                ];
            }
        }
        yield 'an enum past what a browser holds in a query string' => [
            $page(
                str_replace('BIG', '9007199254740993', $big)
                    . "use Crab\\Psx\\Query;\nuse Crab\\Routing\\FromQuery;\nfinal readonly class Server\n{\n    #[Query]\n    public function find(#[FromQuery] Big \$size): int { return 1; }\n}",
            ),
            'find() takes an enum with the value 9007199254740993',
        ];
        yield 'an enum past what a browser holds in what a method gives' => [
            $page(
                str_replace('BIG', '9007199254740993', $big)
                    . "use Crab\\Psx\\Query;\nfinal readonly class Server\n{\n    #[Query]\n    public function size(): Big { return Big::Small; }\n}",
            ),
            'whose case Big is 9007199254740993',
        ];
        yield 'an enum past what a browser holds in a page\'s data' => [
            $page(
                str_replace('BIG', '9007199254740993', $big)
                    . "final readonly class Data { public function __construct(public ?Big \$size = null) {} }\nfinal readonly class Server\n{\n    public function load(): Data { return new Data(); }\n}",
            ),
            'whose case Big is 9007199254740993',
        ];
        yield 'a page without a name' => [
            $pages("    \$pages->page('/', 'resources/pages/Home.psx');"),
            'The page / has no name',
        ];
        yield 'a name twice' => [
            $pages(
                "    \$pages->page('/', 'resources/pages/Home.psx')->name('home');\n    \$pages->page('/again', 'resources/pages/Home.psx')->name('home');",
            ),
            'is named "home", and so is the page /',
        ];
        yield 'a missing file' => [
            $pages("    \$pages->page('/', 'resources/pages/Nope.psx')->name('home');"),
            'names a file that does not exist',
        ];
        yield 'an undeclared layout' => [
            $pages("    \$pages->page('/', 'resources/pages/Home.psx')->name('home')->layout('nope');"),
            'none is declared by that name',
        ];
        yield 'a layout twice in a chain' => [
            $pages(
                "    \$pages->layout('app', 'resources/layouts/App.psx');\n    \$pages->page('/', 'resources/pages/Home.psx')->name('home')->layout('app', 'app');",
            ),
            'is put in the same layout twice',
        ];
        yield 'the reserved segment' => [
            $pages("    \$pages->page('/_psx/x', 'resources/pages/Home.psx')->name('home');"),
            'has the segment _psx',
        ];
        yield 'a guard that is not middleware' => [
            $pages("    \$pages->page('/', 'resources/pages/Home.psx')->name('home')->middleware(stdClass::class);"),
            'stdClass is named as middleware, and it is not one',
        ];
        yield 'a guard for a method that is not there' => [
            $pages("    \$pages->page('/', 'resources/pages/Home.psx')->name('home')->operation('nope');"),
            'guards the operation "nope"',
        ];
        yield 'a page that is also a service' => [
            $pages(
                "    \$pages->page('/', 'resources/pages/Home.psx')->name('home');\n    \$pages->service('/svc', 'resources/pages/Home.psx')->name('svc');",
            ),
            'is declared as a page and as a service',
        ];
        yield 'a page over an ordinary route' => [
            $pages("    \$pages->page('/plain', 'resources/pages/Home.psx')->name('home');"),
            'GET /plain',
        ];
        yield 'two loaders that disagree on a query field' => [
            [
                ...$pages(
                    "    \$pages->layout('app', 'resources/layouts/App.psx');\n    \$pages->page('/', 'resources/pages/Home.psx')->name('home')->layout('app');",
                ),
                ...$page(
                    "use Crab\\Routing\\FromQuery;\nfinal readonly class D { public function __construct(public int \$t) {} }\nfinal readonly class Server\n{\n    public function load(#[FromQuery] int \$theme = 1): D { return new D(\$theme); }\n}",
                ),
            ],
            'reads the query field "theme"',
        ];
    }

    public function testAParameterOfOneSegmentKeepsItsQueriesHoweverItIsConstrained(): void
    {
        $page = "<script lang=\"php\">\nuse Crab\\Psx\\Query;\nfinal readonly class Listing { public function __construct(public string \$tail) {} }\nfinal readonly class Server\n{\n    public function load(string \$tail): Listing { return new Listing(\$tail); }\n    #[Query]\n    public function ping(string \$tail): string { return \"pong:{\$tail}\"; }\n}\n</script>\nexport default function Files() { return null; }\n";
        $fixture = FixtureApp::copy(['resources/pages/Files.psx' => $page]);
        $fixture->write('routes/pages.php', str_replace(
            "\$pages->service('/people',",
            "\$pages->page('/files/{tail:[a-z0-9.-]+}', 'resources/pages/Files.psx')->name('files');\n    \$pages->page('/tree/{tail:.+}/view', 'resources/pages/Files.psx')->name('tree');\n    \$pages->service('/people',",
            $fixture->read('routes/pages.php'),
        ));
        $psx = $fixture->serve();

        self::assertSame('pong:a.txt', $psx->query('files/page', 'ping', ['tail' => 'a.txt'])->assertOk()->data());
        // A parameter of many segments that is not the path's last takes no query's address either.
        self::assertSame('pong:a/b', $psx->query('tree/page', 'ping', ['tail' => 'a/b'])->assertOk()->data());
        self::assertSame('a/b', $psx->navigate('/tree/a/b/view')->assertOk()->data(0)['tail']);
    }

    // R4-S01

    #[DataProvider('named')]
    public function testAnEnumPastWhatABrowserHoldsIsRefusedAlsoWhereWhatTakesItIsNamedEnum(
        string $classes,
        string $method,
        string $said,
    ): void {
        $fixture = FixtureApp::copy(['resources/pages/Home.psx' => self::page(
            "enum Big: int\n{\n    case Small = 1;\n    case Edge = 9007199254740991;\n    case Big = 9007199254740993;\n}\n"
            . $classes,
            $method,
        )]);

        try {
            $fixture->compile();
            self::fail('It was compiled.');
        } catch (PsxException $refused) {
            self::assertStringContainsString(
                "{$said} takes an enum with the value 9007199254740993",
                $refused->getMessage(),
            );
            self::assertSame('resources/pages/Home.psx', $refused->source);
            self::assertIsInt($refused->sourceLine);
        }
        // Nothing was written of it for a script to import.
        self::assertStringNotContainsString('9007199254740993', self::written("{$fixture->base}/.psx"));
    }

    /**
     * @return iterable<string, array{string, string, string}>
     */
    public static function named(): iterable
    {
        $action =
            static fn(string $parameter): string => "    #[Action]\n    public function choose({$parameter}): int { return 1; }";
        yield 'a field of an action\'s input' => [
            "final readonly class Choice { public function __construct(public Big \$enum) {} }\n",
            $action('Choice $choice'),
            'choose()',
        ];
        yield 'a field that may be null' => [
            "final readonly class Choice { public function __construct(public ?Big \$enum = null) {} }\n",
            $action('Choice $choice'),
            'choose()',
        ];
        yield 'a list of them' => [
            "final readonly class Choice { public function __construct(#[ListOf(Big::class)] public array \$enum = []) {} }\n",
            $action('Choice $choice'),
            'choose()',
        ];
        yield 'an input named enum that holds a field named enum' => [
            "final readonly class Inner { public function __construct(public Big \$enum) {} }\nfinal readonly class Outer { public function __construct(public Inner \$enum) {} }\n",
            $action('Outer $enum'),
            'choose()',
        ];
        yield 'a list named enum of inputs with a field named otherwise' => [
            "final readonly class Inner { public function __construct(public Big \$size) {} }\nfinal readonly class Outer { public function __construct(#[ListOf(Inner::class)] public array \$enum = []) {} }\n",
            $action('Outer $outer'),
            'choose()',
        ];
        yield 'a query field of a query' => [
            '',
            "    #[Query]\n    public function find(#[FromQuery] Big \$enum): int { return 1; }",
            'find()',
        ];
        yield 'a query field of a query that may be null' => [
            '',
            "    #[Query]\n    public function find(#[FromQuery] ?Big \$enum = null): int { return 1; }",
            'find()',
        ];
        yield 'a query field of a loader' => ['', 'LOAD: #[FromQuery] ?Big $enum = null', 'load()'];
    }

    public function testAnEnumABrowserHoldsCompilesWhereWhatTakesItIsNamedEnum(): void
    {
        $fixture = FixtureApp::copy(['resources/pages/Home.psx' => self::page(
            "enum Size: int\n{\n    case Small = 1;\n    case Edge = 9007199254740991;\n    case Low = -9007199254740991;\n}\n"
            . "enum Kind: string\n{\n    case Draft = 'draft';\n    case Long = '9007199254740993';\n}\n"
            . "final readonly class Inner { public function __construct(public Size \$enum, #[ListOf(Kind::class)] public array \$kinds = []) {} }\n"
            . "final readonly class Choice { public function __construct(public Size \$enum, public ?Inner \$inner = null) {} }\n"
            . "final readonly class Named { public function __construct(public Kind \$enum) {} }\n",
            "    #[Action]\n    public function choose(Choice \$enum): int { return \$enum->enum->value; }\n"
            . "    #[Action]\n    public function name(Named \$named): string { return \$named->enum->value; }\n"
            . "    #[Query]\n    public function find(#[FromQuery] Size \$enum, #[FromQuery] ?Kind \$kind = null): int { return \$enum->value; }",
        )]);
        $psx = $fixture->serve();

        $types = self::written("{$fixture->base}/.psx");
        self::assertStringContainsString('9007199254740991', $types);
        self::assertStringContainsString('-9007199254740991', $types);
        // The values are still read strictly where they arrive.
        self::assertSame(1, $psx->action('home/page', 'choose', [], ['enum' => 1])->assertOk()->data());
        self::assertSame(
            9_007_199_254_740_991,
            $psx->query('home/page', 'find', [], ['enum' => '9007199254740991'])->assertOk()->data(),
        );
        self::assertSame('draft', $psx->action('home/page', 'name', [], ['enum' => 'draft'])->assertOk()->data());
        $psx->action('home/page', 'choose', [], ['enum' => 2])->assertProblem(422, execution: 'not-entered');
        $psx->query('home/page', 'find', [], ['enum' => '9007199254740993'])->assertProblem(
            422,
            execution: 'not-entered',
        );
    }

    private static function page(string $classes, string $methods): string
    {
        // "LOAD: ..." gives the loader its parameters, and the page no other method.
        $takes = str_starts_with($methods, 'LOAD: ') ? substr($methods, 6) : '';
        $methods = $takes === '' ? $methods : '';
        return (
            "<script lang=\"php\">\nuse Crab\\Psx\\Action;\nuse Crab\\Psx\\Query;\nuse Crab\\Routing\\FromQuery;\nuse Crab\\Validation\\ListOf;\n"
            . $classes
            . "final readonly class Data { public function __construct(public int \$n = 1) {} }\n"
            . "final readonly class Server\n{\n    public function load({$takes}): Data { return new Data(); }\n{$methods}\n}\n</script>\nexport default function Home() { return null; }\n"
        );
    }

    /**
     * Everything under a folder, as one text.
     */
    private static function written(string $folder): string
    {
        if (!is_dir($folder)) {
            return '';
        }
        $text = '';
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(
            $folder,
            \FilesystemIterator::SKIP_DOTS,
        )) as $file) {
            if ($file->isFile()) {
                $text .= file_get_contents($file->getPathname()) . "\n";
            }
        }
        return $text;
    }

    #[DataProvider('patterns')]
    public function testWhetherARouteMayAnswerAnothersAddressIsProvenNotTried(
        string $earlier,
        string $later,
        bool $shadows,
    ): void {
        self::assertSame($shadows, \Crab\Psx\Compiler\Addresses::shadows($earlier, $later));
    }

    /**
     * @return iterable<string, array{string, string, bool}>
     */
    public static function patterns(): iterable
    {
        $query = '/posts/{id}/_psx/q/0123456789abcdef';
        yield 'another first segment' => ['/api/{rest:.+}', $query, false];
        yield 'fewer segments, none spanning' => ['/posts/{id}', $query, false];
        yield 'more segments, none spanning' => ['/{a}/{b}/{c}/{d}/{e}/{f}', $query, false];
        yield 'text that differs in the middle' => ['/posts/{id}/files/{a}/{b}', $query, false];
        yield 'an expression seen not to take _psx' => ['/posts/{id}/{kind:[a-z]+}/{a}/{b}', $query, false];
        yield 'an expression seen not to take the id' => ['/posts/{id}/_psx/q/{n:\d+}', $query, false];
        yield 'text after a spanning parameter that differs' => ['/posts/{rest:.+}/view', $query, false];
        yield 'a spanning parameter after text that differs' => ['/posts/{id}/files/{rest:.+}', $query, false];

        yield 'parameters of one segment throughout' => ['/{a}/{b}/{c}/{d}/{e}', $query, true];
        yield 'the same shape under other names' => ['/posts/{post}/{a}/{b}/{c}', $query, true];
        yield 'everything' => ['/{any:.*}', $query, true];
        yield 'everything under the same first segment' => ['/posts/{rest:.+}', $query, true];
        yield 'an expression that takes the id' => ['/posts/{id}/_psx/q/{n:[a-f0-9]+}', $query, true];
        yield 'a parameter inside a segment' => ['/posts/{id}/_{what}/q/{n}', $query, true];
        yield 'an expression not spelled so as to be seen through' => [
            '/posts/{id:(?i)[a-z]+}/{a}/{b}/{c}',
            $query,
            true,
        ];
        yield 'a spanning parameter whose text after it is a parameter' => ['/posts/{rest:.+}/{last}', $query, true];
        yield 'a later route that spans, met at its text' => [
            '/files/{a}/{b}/{c}/ab',
            '/files/{tail:.+}/_psx/q/ab',
            true,
        ];
        yield 'a later route that spans, apart at the end' => ['/files/{a}/view', '/files/{tail:.+}/_psx/q/ab', false];
    }

    public function testAnOrdinaryRouteDeclaredBeforeThePagesMayNotAnswerAQueryOrAnAction(): void
    {
        $web = static fn(string $routes): array => [
            'routes/web.php' => "<?php

use Crab\\Route;

Route::get('/plain', static fn(): array => ['plain' => true]);
{$routes}
",
        ];
        foreach ([
            'a GET that takes everything' => [
                "Route::get('/{any:.*}', static fn(string \$any): array => []);",
                'GET /{any:.*}',
            ],
            'a POST that takes everything under /posts' => [
                "Route::post('/posts/{rest:.+}', static fn(string \$rest): array => []);",
                'POST /posts/{rest:.+}',
            ],
            'a POST of the same shape' => [
                "Route::post('/{a}/{b}/{c}/{d}/{e}', static fn(string \$a): array => []);",
                'POST /{a}/{b}/{c}/{d}/{e}',
            ],
        ] as $what => [$routes, $named]) {
            try {
                FixtureApp::copy($web($routes))->serve();
                self::fail("{$what} was let through.");
            } catch (PsxException $refused) {
                self::assertStringContainsString(
                    "may be answered by the route {$named}",
                    $refused->getMessage(),
                    $what,
                );
                self::assertStringContainsString('declared before it', $refused->getMessage());
                self::assertStringContainsString('.psx', $refused->getMessage(), $what);
            }
        }

        // What is proven apart is left alone, and both are reached.
        $psx = FixtureApp::copy($web("Route::get('/api/{rest:.+}', static fn(string \$rest): array => ['api' => \$rest]);
"
        . "Route::post('/posts/{id}/{kind:[a-z]+}/{a}/{b}', static fn(): array => ['kind' => true]);
"
        . "Route::get('/{slug:[a-z-]+}', static fn(string \$slug): array => ['slug' => \$slug]);"))->serve();
        // The action's own guard answers, not the ordinary route beside it.
        $psx->action('posts.edit/page', 'touch', ['id' => 7])->assertProblem(401, 'unauthenticated', 'not-entered');
        self::assertSame(
            '{"api":"a\\/b"}',
            (string) $psx->send(new \Crab\Http\Request('GET', '/api/a/b'))->response->getBody(),
        );
    }

    public function testASourceWithoutPhpIsAllTsx(): void
    {
        $source = Source::parse('resources/pages/Plain.psx', "export default 1;\n", 'resources');

        self::assertNull($source->php);
        self::assertFalse($source->server);
        self::assertSame("\nexport default 1;\n", $source->tsx);
    }

    public function testPhpsOwnLexerFindsTheEndOfTheBlock(): void
    {
        $code = "<script lang=\"php\">\n\$x = <<<'TEXT'\n</script> not the end\nTEXT;\n";
        try {
            Source::parse('resources/pages/Odd.psx', $code . "</script>\nexport default 1;\n", 'resources');
            self::fail('A statement that runs was let through.');
        } catch (PsxException $refused) {
            // The heredoc was read as one: what is refused is the assignment, on its own line.
            self::assertStringContainsString('resources/pages/Odd.psx:2: ', $refused->getMessage());
        }
        $source = Source::parse(
            'resources/pages/Odd.psx',
            "<script lang=\"php\">\nconst A = '</script>';\n/* </script> */\n// </script>\nconst B = <<<TEXT\n</script>\nTEXT;\n</script>\nexport const a = '</script>';\n",
            'resources',
        );
        self::assertSame("\n\n\n\n\n\n\n\nexport const a = '</script>';\n", $source->tsx);
        self::assertStringContainsString("const A = '</script>';", (string) $source->php);
        // The compiled PHP keeps the lines of the file: the constant is on line 2 in both.
        self::assertSame(
            2,
            substr_count(substr((string) $source->php, 0, (int) strpos((string) $source->php, 'const A')), "\n") + 1,
        );
    }

    public function testTheBlockMayEndAtTheEndOfTheFile(): void
    {
        $source = Source::parse(
            'resources/components/Shared.psx',
            "<script lang=\"php\">\nfinal readonly class Server {}\n</script>",
            'resources',
        );

        self::assertTrue($source->server);
        self::assertSame("\n\n", $source->tsx);
        self::assertSame(
            "<script lang=\"php\">\nfinal readonly class Server {}\n</script>",
            Source::region("<script lang=\"php\">\nfinal readonly class Server {}\n</script>"),
        );
    }
}
