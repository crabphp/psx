<?php

declare(strict_types=1);

namespace Crab\Psx\Tests;

use Crab\App;
use Crab\Http\Request;
use Crab\Psx\PsxException;
use Crab\Psx\Testing\PsxTest;
use Crab\Psx\Tests\Support\CountingAuth;
use Crab\Psx\Tests\Support\FixtureApp;
use Crab\Psx\Tests\Support\Guard;
use Crab\Psx\Tests\Support\Posts;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * What the first review found the server to promise and not keep
 * (R1-S01 to R1-S07), each through the application's own middleware,
 * router and binder, with what the methods did counted.
 */
final class ContractTest extends TestCase
{
    private const string PAGE = <<<'PSX'
        <script lang="php">
        use Crab\Http\HttpException;
        use Crab\Psx\Action;
        use Crab\Psx\ActionResult;
        use Crab\Psx\Failure;
        use Crab\Psx\Query;
        use Crab\Psx\Tests\Support\CountingAuth;
        use Crab\Psx\Tests\Support\Posts;
        use Crab\Routing\FromQuery;
        use Crab\Validation\ListOf;

        final readonly class Child
        {
            public function __construct(
                public string $name = 'default',
                #[ListOf('string')]
                public array $tags = [],
            ) {}
        }

        final readonly class Shape
        {
            public function __construct(
                public Child $child = new Child(),
                #[ListOf('int')]
                public array $items = [],
                public int $count = 0,
                public string $reference = '',
            ) {}
        }

        final readonly class Loaded
        {
            public function __construct(public string $q) {}
        }

        final readonly class Fail
        {
            public function __construct(public int $status) {}
        }

        final readonly class Server
        {
            public function __construct(private Posts $posts) {}

            public function load(int $id, #[FromQuery] string $q = '', #[FromQuery] int $page = 1): Loaded|Failure
            {
                $this->posts->ran[] = "load:{$q}";
                if ($id === 404) {
                    return Failure::notFound('No such review.');
                }
                return new Loaded($q);
            }

            #[Action]
            public function thrown(int $id, Fail $input): string
            {
                $this->posts->ran[] = 'write';
                throw new HttpException($input->status, 'Thrown after the write.');
            }

            /** @return ActionResult<string> */
            #[Action]
            public function returned(int $id): ActionResult
            {
                $this->posts->ran[] = 'checked';
                return ActionResult::fail(Failure::conflict('Nothing was kept.'));
            }

            #[Action]
            public function unsendable(int $id): int
            {
                $this->posts->ran[] = 'write';
                return PHP_INT_MAX;
            }

            #[Action]
            public function replaced(int $id): string
            {
                $this->posts->ran[] = 'write';
                return 'kept';
            }

            #[Action]
            public function overthrown(int $id): string
            {
                $this->posts->ran[] = 'write';
                return 'kept';
            }

            #[Action]
            public function barred(int $id): string
            {
                $this->posts->ran[] = 'write';
                return 'kept';
            }

            #[Action]
            public function opened(int $id): string
            {
                $this->posts->ran[] = 'opened';
                return 'kept';
            }

            #[Action]
            public function proxied(int $id): string
            {
                $this->posts->ran[] = 'proxied';
                return 'kept';
            }

            /** @return ActionResult<Shape> */
            #[Action]
            public function shaped(int $id, Shape $input): ActionResult
            {
                $this->posts->ran[] = 'shaped';
                return ActionResult::ok($input);
            }

            #[Query]
            public function counted(int $id, #[FromQuery] int $from = 0): int
            {
                $this->posts->ran[] = 'counted';
                return $from;
            }

            /** @return ActionResult<string> */
            #[Action]
            public function unmarked(int $id): ActionResult
            {
                $this->posts->ran[] = 'write';
                return ActionResult::ok('in')->authChanged()->cookie(new \Crab\Http\Cookie('session', 'new'));
            }
            //MARKED
        }
        </script>
        export default function Review() {
            return null;
        }
        PSX;

    private const string MARKED = <<<'PHP'

            /** @return ActionResult<string> */
            #[Action(auth: true)]
            public function signIn(int $id): ActionResult
            {
                $this->posts->ran[] = 'signIn';
                CountingAuth::$revision = '4';
                return ActionResult::ok('in')->authChanged();
            }

            /** @return ActionResult<string> */
            #[Action(auth: true)]
            public function refuseIn(int $id, Shape $input): ActionResult
            {
                $this->posts->ran[] = 'refuseIn';
                if ($input->reference === 'moved') {
                    CountingAuth::$revision = '4';
                }
                return ActionResult::fail(Failure::validation(['reference' => 'is not known']));
            }

            /** @return ActionResult<string> */
            #[Action(auth: true)]
            public function guardedIn(int $id): ActionResult
            {
                $this->posts->ran[] = 'guardedIn';
                return ActionResult::ok('in')->authChanged();
            }
        PHP;

    private static FixtureApp $fixture;
    private PsxTest $psx;
    private Posts $posts;

    /**
     * The fixture application with the page above, routes of its own
     * beside it, and an AuthState where asked.
     */
    private static function fixture(bool $adapter, bool $marked = false, string $more = ''): FixtureApp
    {
        $fixture = FixtureApp::copy([
            'resources/pages/Review.psx' => str_replace('//MARKED', $marked ? self::MARKED : '', self::PAGE),
            ...(
                $adapter
                    ? [
                        'config/psx.php' =>
                            "<?php\nreturn ['auth_state' => " . var_export(CountingAuth::class, true) . "];\n",
                    ]
                    : []
            ),
            'routes/web.php' => <<<'PHP'
                <?php

                declare(strict_types=1);

                use Crab\Psx\Tests\Support\Guard;
                use Crab\Route;

                Route::get('/plain', static fn(): array => ['plain' => true]);
                Route::post('/ordinary', static function (): array {
                    Guard::$ran[] = 'ordinary';
                    return ['ordinary' => true];
                });
                Route::post('/old/{rest:.+}', static function (string $rest): array {
                    Guard::$ran[] = 'fallback';
                    return ['fallback' => $rest];
                });
                Route::get('/notes/_psx/q/{id}', static function (string $id, Crab\Contracts\Http\Request $request): array {
                    return ['read' => $request->getQueryParams()];
                });
                PHP,
        ]);
        $fixture->write('routes/pages.php', str_replace("\$pages->service('/people',", <<<'PHP'
            $pages->page('/review/{id}', 'resources/pages/Review.psx')
                ->name('review')
                ->layout('app')
                ->middleware(new Guard('eager', $errors, open: true, reads: true))
                ->operation('replaced', new Crab\Psx\Tests\Support\Late('return', $errors))
                ->operation('overthrown', new Crab\Psx\Tests\Support\Late('throw', $errors))
                ->operation('barred', new Crab\Psx\Tests\Support\Late('before', $errors))
                ->operation('opened', Crab\Http\SameOrigin::class)
                ->operation('proxied', new Crab\Http\SameOrigin('https://shop.example'))
            PHP . (
            $marked ? "\n    ->operation('guardedIn', new Crab\\Psx\\Tests\\Support\\Late('before', \$errors))" : ''
        ) . ';' . $more . "\n    \$pages->service('/people',", $fixture->read('routes/pages.php')));
        return $fixture;
    }

    public static function setUpBeforeClass(): void
    {
        self::$fixture = self::fixture(adapter: true, marked: true);
        self::$fixture->compile();
    }

    protected function setUp(): void
    {
        Guard::$ran = [];
        CountingAuth::$revision = '3';
        CountingAuth::$partition = 'user-1';
        $this->psx = self::$fixture->serve();
        $this->posts = $this->psx->container()->get(Posts::class);
    }

    // R1-S01

    /**
     * @param array<string, mixed> $input
     */
    #[DataProvider('unexpected')]
    public function testAFailureAfterTheMethodBeganPromisesNothingOfWhatItDid(
        string $method,
        array $input,
        int $status,
    ): void {
        $failed = $this->psx->action('review/page', $method, ['id' => 7], $input);

        $failed->assertProblem($status, execution: 'entered');
        self::assertFalse($failed->expected());
        self::assertSame(['write'], $this->posts->ran);
        self::assertStringNotContainsString('kept', (string) $failed->response->getBody());
    }

    /**
     * @return iterable<string, array{string, array<string, mixed>, int}>
     */
    public static function unexpected(): iterable
    {
        yield 'a 422 thrown after the write' => ['thrown', ['status' => 422], 422];
        yield 'a 409 thrown after the write' => ['thrown', ['status' => 409], 409];
        yield 'a 404 thrown after the write' => ['thrown', ['status' => 404], 404];
        yield 'a 500 thrown after the write' => ['thrown', ['status' => 500], 500];
        yield 'what it returned could not be sent' => ['unsendable', [], 500];
        yield 'a middleware answered 422 in its place' => ['replaced', [], 422];
        yield 'a middleware threw 409 after it' => ['overthrown', [], 409];
    }

    public function testARefusalBeforeTheMethodAndAFailureItReturnedSayNothingWasKept(): void
    {
        $returned = $this->psx->action('review/page', 'returned', ['id' => 7]);
        $returned->assertProblem(409, 'conflict', 'entered');
        self::assertTrue($returned->expected());
        self::assertSame(['checked'], $this->posts->ran);

        $this->posts->ran = [];
        foreach ([
            'input that did not bind' => $this->psx->action('review/page', 'thrown', ['id' => 7], ['status' => 'x']),
            'a path that did not bind' => $this->psx->action('review/page', 'thrown', ['id' => 'x'], ['status' => 422]),
            'a guard that threw' => $this->psx->action('review/page', 'barred', ['id' => 7]),
            'another release' => $this->psx->action(
                'review/page',
                'replaced',
                ['id' => 7],
                [],
                [
                    'X-PSX-Build' => 'older',
                ],
            ),
        ] as $what => $refused) {
            self::assertSame('not-entered', $refused->execution(), $what);
            self::assertTrue($refused->expected(), $what);
        }
        self::assertSame([], $this->posts->ran);
    }

    // R1-S02

    public function testAnObjectIsNotAListNorAListAnObjectAtAnyDepth(): void
    {
        $send = fn(string $json): \Crab\Psx\Testing\PsxResponse => $this->psx->send(
            new Request('POST', $this->psx->path('review/page', 'shaped', [
                'id' => 7,
            ]), [...$this->psx->protocol($this->psx->schema('review/page', 'shaped')), 'Content-Type' => 'application/json'], $json),
        );

        $valid = $send('{"child":{},"items":[],"count":9007199254740991,"reference":"9007199254740993"}')->assertOk();
        self::assertSame(
            [
                'child' => ['name' => 'default', 'tags' => []],
                'items' => [],
                'count' => 9_007_199_254_740_991,
                'reference' => '9007199254740993',
            ],
            $valid->data(),
        );
        $send('{"child":{"tags":["a"]},"items":[7],"count":-9007199254740991}')->assertOk();
        self::assertSame(['shaped', 'shaped'], $this->posts->ran);

        $this->posts->ran = [];
        foreach ([
            '{"child":[],"items":{"0":7},"count":9007199254740993}' => ['child', 'items', 'count'],
            '{"child":[]}' => ['child'],
            '{"items":{}}' => ['items'],
            '{"items":{"0":7}}' => ['items'],
            '{"child":{"tags":{"0":"a"}}}' => ['child.tags'],
            '{"count":9007199254740992}' => ['count'],
            '{"count":-9007199254740992}' => ['count'],
            '{"items":[9007199254740992]}' => ['items.0'],
        ] as $json => $fields) {
            $refused = $send($json)->assertProblem(422, 'validation', 'not-entered');
            self::assertSame($fields, array_keys($refused->problem()['fields']), $json);
        }
        $send('{"count":1,"count":2}')->assertProblem(400, execution: 'not-entered');
        self::assertSame([], $this->posts->ran);
    }

    public function testAWholeNumberIsOneABrowserHoldsExactlyInAPathAQueryAndAForm(): void
    {
        $this->psx
            ->query('review/page', 'counted', ['id' => 9_007_199_254_740_991], ['from' => -9_007_199_254_740_991])
            ->assertOk();
        $this->psx
            ->form(
                'review/page',
                'shaped',
                ['id' => 7],
                [
                    ['count',    '9007199254740991'],
                    ['items[0]', '-9007199254740991'],
                ],
            )
            ->assertOk();
        self::assertSame(['counted', 'shaped'], $this->posts->ran);

        $this->posts->ran = [];
        $path = $this->psx->query('review/page', 'counted', ['id' => '9007199254740992']);
        $path->assertProblem(422, execution: 'not-entered');
        self::assertArrayHasKey('id', $path->problem()['path']);
        $query = $this->psx->query('review/page', 'counted', ['id' => 7], ['from' => '-9007199254740992']);
        $query->assertProblem(422, execution: 'not-entered');
        self::assertArrayHasKey('from', $query->problem()['query']);
        $this->psx->form('review/page', 'shaped', ['id' => 7], [['count', '9007199254740992']])->assertProblem(
            422,
            execution: 'not-entered',
        );
        $this->psx->form('review/page', 'shaped', ['id' => 7], [['items[0]', '9007199254740992']])->assertProblem(
            422,
            execution: 'not-entered',
        );
        // A page's loader is held to it too, for a browser as for the page.
        self::assertSame(422, $this->psx->document('/review/9007199254740992')->status());
        $this->psx->navigate('/review/7?page=9007199254740992')->assertProblem(422, execution: 'not-entered');
        self::assertSame(['layout', 'layout'], $this->posts->ran);
    }

    // R1-S03

    /**
     * @param string $query What follows the page's address.
     */
    #[DataProvider('ambiguous')]
    public function testADocumentIsReadAsStrictlyAsANavigation(string $query, int $status): void
    {
        $document = $this->psx->document("/review/7?{$query}");
        $navigation = $this->psx->navigate("/review/7?{$query}");

        self::assertSame($status, $document->status(), (string) $document->response->getBody());
        self::assertSame($status, $navigation->status());
        // The browser is answered by the application's own error, the page in the protocol.
        self::assertNull($document->kind());
        self::assertNull($document->bootstrap());
        $navigation->assertProblem($status, execution: 'not-entered');
        // A guard read the query string first, and no loader ran, the layout's included.
        self::assertSame(['eager', 'eager'], array_values(array_intersect(Guard::$ran, ['eager'])));
        self::assertSame([], $this->posts->ran);
    }

    /**
     * @return iterable<string, array{string, int}>
     */
    public static function ambiguous(): iterable
    {
        yield 'a field said twice' => ['q=one&q=two', 400];
        yield 'the layout\'s field said twice' => ['theme=dark&theme=light', 400];
        yield 'a dot in a name' => ['q.x=1', 400];
        yield 'a space in a name' => ['q%20x=1', 400];
        yield 'a list written two ways' => ['t[]=a&t[0]=b', 400];
        yield 'a place left out' => ['t[0]=a&t[2]=b', 400];
        yield 'nested past the bound' => ['a' . str_repeat('[b]', 40) . '=1', 413];
        yield 'a name past the bound' => [str_repeat('n', 300) . '=1', 413];
    }

    public function testADocumentAndANavigationGiveTheLoadersTheSameFields(): void
    {
        $document = $this->psx->document('/review/7?q=one&theme=dark')->assertOk();
        $navigation = $this->psx->navigate('/review/7?q=one&theme=dark')->assertOk();

        self::assertSame($navigation->envelope['nodes'], $document->bootstrap()['envelope']['nodes']);
        self::assertSame('dark', $navigation->data(0)['theme']);
        self::assertSame(['q' => 'one'], $navigation->data(1));
    }

    public function testAnOrdinaryRouteKeepsItsReadingWhateverItsPathHolds(): void
    {
        $read = $this->psx->send(new Request('GET', '/notes/_psx/q/1?a=1&a=2&b.c=3', ['Accept' => 'application/json']));
        $missing = $this->psx->send(new Request('GET', '/notes/_psx/nowhere', ['Accept' => 'application/json']));

        // PHP's own reading: the last of two, and a dot made an underscore.
        self::assertSame('{"read":{"a":"2","b_c":"3"}}', (string) $read->response->getBody());
        self::assertSame('{"error":{"status":404,"message":"Not Found"}}', (string) $missing->response->getBody());
    }

    // R1-S04

    /**
     * @param array<string, string> $headers
     */
    #[DataProvider('foreign')]
    public function testAPageOfAnotherReleaseEntersNothingWhateverItsAddressLeadsTo(
        array $headers,
        int $status,
        string $code,
    ): void {
        $protocol = [
            ...$this->psx->protocol('old-schema'),
            'Content-Type' => 'application/json',
            'X-Pass' => 'group,save',
            ...$headers,
        ];
        foreach ([
            'an action of this release' => $this->psx->path('review/page', 'replaced', ['id' => 7]),
            'an action that was removed' => '/review/7/_psx/a/0000000000000000',
            'an ordinary route' => '/ordinary',
            'an ordinary fallback' => '/old/review/7/_psx/a/0000000000000000',
            'no route at all' => '/nowhere',
        ] as $what => $path) {
            $refused = $this->psx->send(new Request('POST', $path, $protocol, '{}'));
            $refused->assertProblem($status, $code, 'not-entered');
            self::assertTrue($refused->expected(), $what);
        }
        self::assertSame([], $this->posts->ran);
        self::assertSame([], Guard::$ran);
    }

    /**
     * @return iterable<string, array{array<string, string>, int, string}>
     */
    public static function foreign(): iterable
    {
        yield 'an older release' => [['X-PSX-Build' => 'older'], 409, 'build_mismatch'];
        yield 'no release said' => [['X-PSX-Build' => ''], 409, 'build_mismatch'];
        yield 'another protocol' => [['X-PSX-Protocol' => '99', 'X-PSX-Build' => 'older'], 400, 'unsupported_protocol'];
        yield 'another protocol of this release' => [['X-PSX-Protocol' => '99'], 400, 'unsupported_protocol'];
    }

    public function testThisReleasesPageIsToldWhatIsNotThereAndAnOrdinaryRequestIsLeftAlone(): void
    {
        $current = [...$this->psx->protocol('any'), 'Content-Type' => 'application/json'];

        $this->psx->send(new Request('POST', '/review/7/_psx/a/0000000000000000', $current, '{}'))->assertProblem(
            404,
            'not_found',
            'not-entered',
        );
        // The schema is the route's to check, once the route is known: before the method.
        $this->psx->send(new Request('POST', $this->psx->path('review/page', 'returned', [
            'id' => 7,
        ]), $current, '{}'))->assertProblem(409, 'build_mismatch', 'not-entered');
        self::assertSame([], $this->posts->ran);

        Guard::$ran = [];
        $ordinary = $this->psx->send(new Request('POST', '/ordinary', ['Content-Type' => 'application/json'], '{}'));
        $fallback = $this->psx->send(new Request('POST', '/old/anything/else'));
        self::assertSame('{"ordinary":true}', (string) $ordinary->response->getBody());
        self::assertSame('{"fallback":"anything\/else"}', (string) $fallback->response->getBody());
        self::assertSame(['ordinary', 'fallback'], Guard::$ran);
    }

    // R1-S05

    public function testOnlyAnActionDeclaredSoSaysWhoIsSignedInChanged(): void
    {
        $unmarked = $this->psx->action('review/page', 'unmarked', ['id' => 7]);

        // It ran, so nothing is said of what it did; and it is told to nobody as a sign-in.
        $unmarked->assertProblem(500, 'server_error', 'entered');
        self::assertFalse($unmarked->expected());
        self::assertSame(['write'], $this->posts->ran);
        self::assertFalse($unmarked->response->hasHeader('Set-Cookie'));
        self::assertStringNotContainsString('authChanged', (string) $unmarked->response->getBody());

        // The same without an AuthState.
        $bare = self::fixture(adapter: false)->serve();
        $failed = $bare->action('review/page', 'unmarked', ['id' => 7]);
        $failed->assertProblem(500, 'server_error', 'entered');
        self::assertFalse($failed->expected());
        self::assertFalse($failed->response->hasHeader('Set-Cookie'));
    }

    public function testADeclaredSignInIsHeldToTheRevisionItSaw(): void
    {
        $this->psx->action('review/page', 'signIn', ['id' => 7])->assertProblem(409, 'auth_transition', 'not-entered');
        $stale = $this->psx->action('review/page', 'signIn', ['id' => 7], [], ['X-PSX-Auth-Revision' => '2']);
        $stale->assertProblem(409, 'auth_transition', 'not-entered');
        self::assertTrue($stale->expected());
        self::assertSame([], $this->posts->ran);

        $done = $this->psx
            ->action('review/page', 'signIn', ['id' => 7], [], ['X-PSX-Auth-Revision' => '3'])
            ->assertOk();
        self::assertTrue($done->envelope['authChanged']);
        self::assertSame('4', $done->envelope['auth']['revision']);
        self::assertSame(['signIn'], $this->posts->ran);
    }

    public function testARefusalOfASignInSaysWhoIsSignedInOnlyOncePastItsGuards(): void
    {
        $seen = ['X-PSX-Auth-Revision' => '3'];
        $now = ['context' => 'browser-1', 'revision' => '3', 'partition' => 'user-1'];

        // A failure the method returned, and input that did not bind: both past the guards and the
        // revision, and both say who is signed in, as read after the method.
        $failed = $this->psx->action('review/page', 'refuseIn', ['id' => 7], [], $seen);
        $failed->assertProblem(422, 'validation', 'entered');
        self::assertSame($now, $failed->envelope['auth']);
        $unbound = $this->psx->action('review/page', 'refuseIn', ['id' => 7], ['count' => 'x'], $seen);
        $unbound->assertProblem(422, execution: 'not-entered');
        self::assertSame($now, $unbound->envelope['auth']);
        $moved = $this->psx->action('review/page', 'refuseIn', ['id' => 7], ['reference' => 'moved'], $seen);
        $moved->assertProblem(422, 'validation', 'entered');
        self::assertSame('4', $moved->envelope['auth']['revision']);

        // A guard's refusal, a stale revision, and a refusal of an action that changes nobody: none
        // is given a word of who is signed in, and no AuthState is asked for one.
        CountingAuth::$revision = '3';
        $this->posts->ran = [];
        $guarded = $this->psx->action('review/page', 'guardedIn', ['id' => 7], [], $seen);
        $guarded->assertProblem(403, execution: 'not-entered');
        self::assertTrue($guarded->expected());
        $stale = $this->psx->action('review/page', 'signIn', ['id' => 7], [], ['X-PSX-Auth-Revision' => '2']);
        $ordinary = $this->psx->action('review/page', 'shaped', ['id' => 7], ['count' => 'x']);
        $ordinary->assertProblem(422, execution: 'not-entered');
        foreach ([$guarded, $stale, $ordinary] as $refused) {
            self::assertArrayNotHasKey('auth', $refused->envelope);
        }
        self::assertSame([], $this->posts->ran);
    }

    public function testADeclaredSignInWithoutAnAuthStateIsRefusedWhenTheApplicationIsDefined(): void
    {
        $fixture = self::fixture(adapter: false, marked: true);

        $this->expectException(PsxException::class);
        $this->expectExceptionMessage('psx.auth_state');
        $fixture->serve();
    }

    // R1-S06

    public function testNothingOfTheApplicationsIsMadeUntilAWorkerNeedsIt(): void
    {
        CountingAuth::$made = [];
        $psx = self::$fixture->serve();
        $app = App::current();

        // Defined, and its wiring read, with nothing made.
        self::assertSame([], $app->unmade());
        self::assertSame([], CountingAuth::$made);
        // A refusal that carries nobody's data asks nothing of it either.
        $psx->navigate('/review/7', ['X-PSX-Build' => 'older'])->assertProblem(409);
        self::assertSame([], CountingAuth::$made);

        // Two workers forked from here each make their own, on their first request.
        $made = [];
        foreach ([1, 2] as $worker) {
            $file = tempnam(sys_get_temp_dir(), 'psx-worker-');
            $child = pcntl_fork();
            if ($child === 0) {
                $psx->navigate('/review/7');
                $psx->navigate('/review/7');
                file_put_contents($file, json_encode([getmypid(), CountingAuth::$made]));
                // Nothing of the test's is run again by the worker.
                posix_kill((int) getmypid(), SIGKILL);
            }
            pcntl_waitpid((int) $child, $status);
            $made[] = json_decode((string) file_get_contents($file), true);
            unlink($file);
        }
        self::assertSame([$made[0][0]], $made[0][1]);
        self::assertSame([$made[1][0]], $made[1][1]);
        self::assertNotSame($made[0][0], $made[1][0]);
        self::assertSame([], CountingAuth::$made);

        $psx->navigate('/review/7')->assertOk();
        $psx->navigate('/review/7')->assertOk();
        self::assertSame([getmypid()], CountingAuth::$made);
    }

    public function testAnAuthStateThatCannotBeMadeIsSaidWithoutMakingIt(): void
    {
        $fixture = self::fixture(adapter: false);
        $fixture->write(
            'config/psx.php',
            "<?php\nreturn ['auth_state' => 'Crab\\\\Psx\\\\Tests\\\\Support\\\\NeedsMissing'];\n",
        );
        $fixture->serve();

        $problems = App::current()->unmade();

        self::assertCount(1, $problems);
        self::assertStringStartsWith('"psx.auth_state": ', $problems[0]);
    }

    // R1-S07

    /**
     * @param array<string, string> $headers
     */
    #[DataProvider('accepts')]
    public function testADocumentIsGivenOnlyToWhoTakesHtml(array $headers, int $status): void
    {
        $response = $this->psx->send(new Request('GET', '/review/7?q=x', $headers));

        self::assertSame($status, $response->status());
        self::assertSame($status === 200 ? ['layout', 'load:x'] : [], $this->posts->ran);
        if ($status === 406) {
            // The application's own error, in what was asked for.
            self::assertNull($response->kind());
            self::assertStringNotContainsString('psx-bootstrap', (string) $response->response->getBody());
        }
    }

    /**
     * @return iterable<string, array{array<string, string>, int}>
     */
    public static function accepts(): iterable
    {
        yield 'no Accept' => [[], 200];
        yield 'a browser' => [
            ['Accept' => 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8'],
            200,
        ];
        yield 'anything' => [['Accept' => '*/*'], 200];
        yield 'any text' => [['Accept' => 'text/*;q=0.5'], 200];
        yield 'JSON only' => [['Accept' => 'application/json'], 406];
        yield 'HTML refused' => [['Accept' => 'text/html;q=0'], 406];
        yield 'HTML refused, anything else taken' => [['Accept' => 'text/html;q=0, */*;q=0.8'], 406];
        yield 'text refused, anything else taken' => [['Accept' => 'text/*;q=0, */*'], 406];
        yield 'HTML taken, text refused' => [['Accept' => 'text/*;q=0, text/html'], 200];
    }

    public function testAnOrdinaryRouteNegotiatesNothingNew(): void
    {
        $plain = $this->psx->send(new Request('GET', '/plain', ['Accept' => 'text/html;q=0']));

        self::assertSame('{"plain":true}', (string) $plain->response->getBody());
    }

    // R3-S01, what is sent

    public function testAnEnumValueJavaScriptCannotHoldIsNotSent(): void
    {
        $codec = new \Crab\Psx\Runtime\WireCodec();
        $shape = ['k' => 'enum', 'class' => \Crab\Psx\Tests\Support\Huge::class];

        self::assertSame(1, $codec->encode($shape, \Crab\Psx\Tests\Support\Huge::Small, 'data'));
        self::assertSame(9_007_199_254_740_991, $codec->encode($shape, \Crab\Psx\Tests\Support\Huge::Edge, 'data'));
        foreach (['Over', 'Next', 'Under'] as $case) {
            try {
                $codec->encode(
                    ['k' => 'list', 'of' => $shape],
                    [constant(\Crab\Psx\Tests\Support\Huge::class . "::{$case}")],
                    'data',
                );
                self::fail("{$case} was sent.");
            } catch (\Crab\Psx\Runtime\WireException $refused) {
                self::assertStringContainsString('JavaScript cannot hold exactly', $refused->getMessage());
            }
        }
    }

    // The explicit guard of an action anyone may call

    public function testAnActionWithoutALoginIsGuardedBySameOriginWhereTheApplicationSaysSo(): void
    {
        $post = fn(string $method, array $headers): \Crab\Psx\Testing\PsxResponse => $this->psx->send(
            new Request('POST', $this->psx->path('review/page', $method, [
                'id' => 7,
            ]), [
                ...$this->psx->protocol($this->psx->schema('review/page', $method)),
                'Content-Type' => 'application/json',
                ...$headers,
            ], '{}'),
        );

        // The application's own pages, by app.url or by what the browser says of the request.
        $post('opened', ['Origin' => 'http://localhost'])->assertOk();
        $post('opened', ['Sec-Fetch-Site' => 'same-origin'])->assertOk();
        self::assertSame(['opened', 'opened'], $this->posts->ran);

        $this->posts->ran = [];
        foreach ([
            'another site' => ['Origin' => 'https://evil.example'],
            'another site, said by the browser' => [
                'Origin' => 'https://evil.example',
                'Sec-Fetch-Site' => 'cross-site',
            ],
            'another port' => ['Origin' => 'http://localhost:8080'],
            'another scheme' => ['Origin' => 'https://localhost'],
            'no origin at all' => [],
            'an origin of nowhere' => ['Origin' => 'null'],
        ] as $what => $headers) {
            $refused = $post('opened', $headers);
            $refused->assertProblem(403, 'forbidden', 'not-entered');
            self::assertTrue($refused->expected(), $what);
        }
        self::assertSame([], $this->posts->ran);

        // Behind a proxy the public address is the one configured, whatever host the request reached.
        $post('proxied', ['Origin' => 'https://shop.example', 'Host' => 'internal:9000'])->assertOk();
        $post('proxied', ['Origin' => 'http://internal:9000', 'Host' => 'internal:9000'])->assertProblem(
            403,
            execution: 'not-entered',
        );
        $post('proxied', ['Origin' => 'http://localhost'])->assertProblem(403, execution: 'not-entered');
        self::assertSame(['proxied'], $this->posts->ran);
    }

    // R1-C04, the server's part

    public function testAPageThatFailedPartWaySaysWhoseDataItCarries(): void
    {
        $partial = $this->psx->navigate('/review/404');

        $partial->assertProblem(404, execution: 'entered');
        self::assertSame(['review/app'], array_column($partial->envelope['pageError']['nodes'], 'mount'));
        self::assertSame(
            ['context' => 'browser-1', 'revision' => '3', 'partition' => 'user-1'],
            $partial->envelope['pageError']['auth'],
        );
    }
}
