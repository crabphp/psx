<?php

declare(strict_types=1);

namespace Crab\Psx\Tests;

use Crab\Http\Request;
use Crab\Psx\Testing\PsxTest;
use Crab\Psx\Tests\Support\FixtureApp;
use Crab\Psx\Tests\Support\Guard;
use Crab\Psx\Tests\Support\Posts;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * A compiled application answering its pages, queries and actions
 * through its own middleware, router and binder.
 */
final class RuntimeTest extends TestCase
{
    private static FixtureApp $fixture;
    private PsxTest $psx;
    private Posts $posts;

    public static function setUpBeforeClass(): void
    {
        self::$fixture = FixtureApp::copy();
        self::$fixture->compile();
    }

    protected function setUp(): void
    {
        Guard::$ran = [];
        $this->psx = self::$fixture->serve()->withHeaders(['X-Pass' => 'group,save']);
        $this->posts = $this->psx->container()->get(Posts::class);
    }

    public function testADocumentCarriesTheLoadersDataInOrderAndNoScriptCanEndIt(): void
    {
        $response = $this->psx->document('/posts/7?theme=dark&tab=notes')->assertOk();
        $html = (string) $response->response->getBody();
        $bootstrap = $response->bootstrap();

        self::assertSame('text/html; charset=utf-8', $response->response->getHeaderLine('Content-Type'));
        self::assertSame('private, no-store', $response->response->getHeaderLine('Cache-Control'));
        self::assertStringContainsString('<title>Edit Seven</title>', $html);
        self::assertStringContainsString('content="Editing &lt;a post&gt; &amp; more"', $html);
        self::assertSame(['layout', 'page'], $this->posts->ran);
        self::assertSame('page', $bootstrap['envelope']['kind']);
        self::assertSame(['posts.edit/app', 'posts.edit/page'], array_column($bootstrap['envelope']['nodes'], 'mount'));
        self::assertSame(['name' => 'Ada', 'theme' => 'dark'], $bootstrap['envelope']['nodes'][0]['data']);
        self::assertSame(
            [
                'id' => 7,
                'title' => 'Seven',
                'version' => 3,
                'status' => 'draft',
                'published' => '2026-01-02T03:04:05.000+00:00',
            ],
            $bootstrap['envelope']['nodes'][1]['data']['post'],
        );
        self::assertSame(['id' => '7'], $bootstrap['envelope']['nodes'][1]['scope']['params']);
        self::assertSame('posts.edit:7', $bootstrap['envelope']['nodes'][1]['key']);
        self::assertSame('app:', $bootstrap['envelope']['nodes'][0]['key']);
        // The description's markup is data inside the script element, never markup of the document.
        preg_match('~id="psx-bootstrap">(.*?)</script>~s', $html, $script);
        self::assertStringNotContainsString('<', $script[1]);
        self::assertStringNotContainsString('sentinel-secret', $html);
    }

    public function testANavigationIsTheSameDataAsTheDocument(): void
    {
        $document = $this->psx->document('/posts/7')->bootstrap()['envelope'];
        $navigation = $this->psx->navigate('/posts/7')->assertOk();

        self::assertSame('page', $navigation->kind());
        self::assertSame($document['nodes'], $navigation->envelope['nodes']);
        self::assertSame(['posts', 'post:7'], $navigation->envelope['tags']);
        self::assertSame('Edit Seven', $navigation->envelope['head']['title']);
        self::assertSame($this->psx->build(), $navigation->response->getHeaderLine('X-PSX-Build'));
        self::assertMatchesRegularExpression('/^[0-9a-f]{16}$/', $navigation->response->getHeaderLine('X-PSX-Schema'));
        self::assertSame('Accept', $navigation->response->getHeaderLine('Vary'));
    }

    public function testGuardsRunOuterFirstForThePageAndForEachOperation(): void
    {
        $this->psx->navigate('/posts/7')->assertOk();
        self::assertSame(['group', 'layout', 'page'], Guard::$ran);

        Guard::$ran = [];
        $this->psx->action('posts.edit', 'savePost', ['id' => 7], ['title' => 'New', 'version' => 3])->assertOk();
        self::assertSame(['group', 'layout', 'page', 'save'], Guard::$ran);

        Guard::$ran = [];
        $this->psx->query('posts.edit/app', 'ping', ['id' => 7])->assertOk();
        self::assertSame(['group', 'layout', 'page', 'layout-ping'], Guard::$ran);
    }

    public function testAGuardRefusesTheDocumentTheNavigationAndEveryOperation(): void
    {
        $psx = $this->psx->withHeaders(['X-Pass' => '']);

        $navigation = $psx->navigate('/posts/7')->assertProblem(401, 'unauthenticated', 'not-entered');
        self::assertSame('/login', $navigation->problem()['loginUrl']);
        self::assertSame('Pass', $navigation->response->getHeaderLine('WWW-Authenticate'));
        $psx->query('posts.edit', 'history', ['id' => 7])->assertProblem(401, execution: 'not-entered');
        $psx->action('posts.edit', 'savePost', ['id' => 7], ['title' => 'x', 'version' => 3])->assertProblem(401);
        // The operation's own guard refuses what the family's let through.
        $this->psx
            ->withHeaders(['X-Pass' => 'group'])
            ->action('posts.edit', 'savePost', ['id' => 7], ['title' => 'x', 'version' => 3])
            ->assertProblem(401, execution: 'not-entered');
        self::assertSame([], $this->posts->ran);
        // A document keeps the application's own error for a guard's refusal.
        self::assertSame(401, $psx->document('/posts/7')->status());
        self::assertNull($psx->document('/posts/7')->kind());
    }

    public function testAnActionSavesAndSaysWhatToRefresh(): void
    {
        $saved = $this->psx
            ->action('posts.edit', 'savePost', ['id' => 7], ['title' => 'Renamed', 'version' => 3])
            ->assertOk();

        self::assertSame('action', $saved->kind());
        self::assertTrue($saved->envelope['ok']);
        self::assertSame(4, $saved->data()['version']);
        self::assertSame(['posts', 'post:7'], $saved->envelope['invalidate']);
        self::assertSame(
            ['href' => '/posts/7', 'mode' => 'internal', 'replace' => false],
            $saved->envelope['redirect'],
        );
        self::assertFalse($saved->envelope['authChanged']);
        self::assertCount(2, $saved->response->getHeader('Set-Cookie'));
        self::assertSame('Renamed', $this->posts->posts[7]['title']);
    }

    public function testTwoEditorsCannotCrossSave(): void
    {
        $first = $this->psx->action('posts.edit', 'savePost', ['id' => 7], ['title' => 'First', 'version' => 3]);
        $second = $this->psx->action('posts.edit', 'savePost', ['id' => 7], ['title' => 'Second', 'version' => 3]);

        $first->assertOk();
        $second->assertProblem(409, 'conflict', 'entered');
        self::assertSame('Someone else saved this post.', $second->problem()['message']);
        self::assertSame('First', $this->posts->posts[7]['title']);
    }

    public function testInvalidInputIsRefusedBeforeTheActionAndAReturnedFailureAfter(): void
    {
        $unbound = $this->psx->action('posts.edit', 'savePost', ['id' => 7], ['title' => '', 'version' => 'x']);
        $unbound->assertProblem(422, 'validation', 'not-entered');
        self::assertArrayHasKey('title', $unbound->problem()['fields']);
        self::assertArrayHasKey('version', $unbound->problem()['fields']);
        self::assertSame([], $this->posts->ran);

        $returned = $this->psx->action('posts.edit', 'savePost', ['id' => 7], ['title' => 'taken', 'version' => 3]);
        $returned->assertProblem(422, 'validation', 'entered');
        self::assertSame(['title' => ['is taken']], $returned->problem()['fields']);

        $path = $this->psx->action('posts.edit', 'savePost', ['id' => 'seven'], ['title' => 'x', 'version' => 3]);
        $path->assertProblem(422, execution: 'not-entered');
        self::assertArrayHasKey('id', $path->problem()['path']);
    }

    public function testAVoidActionAnswersNullAndAThrownOneIsNotCalledUnentered(): void
    {
        $touched = $this->psx->action('posts.edit', 'touch', ['id' => 7])->assertOk();
        self::assertNull($touched->data());
        self::assertArrayHasKey('data', $touched->envelope);

        $exploded = $this->psx->action('posts.edit', 'explode', ['id' => 7]);
        $exploded->assertProblem(500, 'server_error', 'entered');
        self::assertStringNotContainsString('It broke', (string) $exploded->response->getBody());
    }

    public function testAQueryGivesDataARefusalOrARedirectAndNeverFollowsOne(): void
    {
        $data = $this->psx->query('posts.edit', 'history', ['id' => 7], ['limit' => 5])->assertOk();
        self::assertSame('query', $data->kind());
        self::assertSame('Seven', $data->data()['title']);
        self::assertSame(['post:7'], $data->envelope['tags']);

        $this->psx->query('posts.edit', 'history', ['id' => 7], ['limit' => 500])->assertProblem(
            403,
            'forbidden',
            'entered',
        );

        $redirect = $this->psx->query('posts.edit', 'history', ['id' => 7], ['limit' => 0])->assertOk();
        self::assertSame('redirect', $redirect->kind());
        self::assertSame('/login', $redirect->envelope['target']['href']);
        self::assertFalse($redirect->response->hasHeader('Location'));

        $this->psx->query('posts.edit', 'history', ['id' => 7], ['limit' => 'many'])->assertProblem(
            422,
            execution: 'not-entered',
        );
    }

    public function testALoaderThatRedirectsOrFailsStopsTheChain(): void
    {
        $document = $this->psx->document('/posts/1');
        self::assertSame(303, $document->status());
        self::assertSame('/posts/7', $document->response->getHeaderLine('Location'));

        $navigation = $this->psx->navigate('/posts/1')->assertOk();
        self::assertSame('redirect', $navigation->kind());
        self::assertSame('/posts/7', $navigation->envelope['target']['href']);

        $missing = $this->psx->navigate('/posts/99')->assertProblem(404, 'not_found', 'entered');
        // The layout that had loaded is kept; the page that failed gives nothing.
        self::assertSame(['posts.edit/app'], array_column($missing->envelope['pageError']['nodes'], 'mount'));
        self::assertSame($this->psx->build(), $missing->envelope['pageError']['build']);

        $page = $this->psx->document('/posts/99');
        self::assertSame(404, $page->status());
        self::assertSame('problem', $page->bootstrap()['envelope']['kind']);
        self::assertSame('No such post.', $page->bootstrap()['envelope']['problem']['message']);
    }

    public function testEachLoaderReadsItsOwnQueryFieldsOfTheOneAddress(): void
    {
        $page = $this->psx->navigate('/posts?q=sev&theme=dark')->assertOk();

        self::assertSame('dark', $page->data(0)['theme']);
        self::assertSame([['id' => 7, 'title' => 'Seven']], $page->data(1)['posts']);
        self::assertSame('/posts?q=sev&theme=dark', $page->envelope['route']['href']);
    }

    /**
     * @param array<string, string> $headers
     */
    #[DataProvider('stale')]
    public function testARequestOfAnotherReleaseOrNoneNeverEntersTheAction(
        array $headers,
        int $status,
        string $code,
    ): void {
        $refused = $this->psx->action(
            'posts.edit',
            'savePost',
            ['id' => 7],
            ['title' => 'Stale', 'version' => 3],
            $headers,
        );

        $refused->assertProblem($status, $code, 'not-entered');
        self::assertSame($this->psx->build(), $refused->envelope['respondingBuild']);
        self::assertSame('Seven', $this->posts->posts[7]['title']);
        self::assertSame([], $this->posts->ran);
    }

    /**
     * @return iterable<string, array{array<string, string>, int, string}>
     */
    public static function stale(): iterable
    {
        yield 'an older build' => [['X-PSX-Build' => 'older'], 409, 'build_mismatch'];
        yield 'another schema' => [['X-PSX-Schema' => 'other'], 409, 'build_mismatch'];
        yield 'another protocol' => [['X-PSX-Protocol' => '2'], 400, 'unsupported_protocol'];
        yield 'no protocol' => [['X-PSX-Protocol' => ''], 400, 'protocol'];
        yield 'html wanted' => [['Accept' => 'text/html'], 406, 'not_acceptable'];
        yield 'the type refused' => [['Accept' => 'application/vnd.crab.psx+json;q=0, */*'], 406, 'not_acceptable'];
        yield 'a text body' => [['Content-Type' => 'text/plain'], 415, 'unsupported_media_type'];
        yield 'a urlencoded body' => [
            ['Content-Type' => 'application/x-www-form-urlencoded'],
            415,
            'unsupported_media_type',
        ];
    }

    public function testARemovedOrForgedOperationIsAMismatchForAnOldPageAndNotFoundForThisOne(): void
    {
        $path = '/posts/7/_psx/a/0000000000000000';
        $old = $this->psx->send(new Request('POST', $path, [
            ...$this->psx->protocol('x'),
            'X-PSX-Build' => 'older',
            'X-Pass' => 'group,save',
        ]));
        $current = $this->psx->send(new Request('POST', $path, [
            ...$this->psx->protocol('x'),
            'X-Pass' => 'group,save',
        ]));

        $old->assertProblem(409, 'build_mismatch', 'not-entered');
        $current->assertProblem(404, 'not_found', 'not-entered');
        // A query's address does not take a POST, nor an action's a GET.
        $wrong = $this->psx->send(new Request(
            'GET',
            $this->psx->path('posts.edit', 'savePost', ['id' => 7]),
            [
                ...$this->psx->protocol($this->psx->schema('posts.edit', 'savePost')),
                'X-Pass' => 'group,save',
            ],
        ));
        $wrong->assertProblem(405, 'method_not_allowed', 'not-entered');
    }

    public function testABodyIsReadStrictly(): void
    {
        $send = fn(string $body): \Crab\Psx\Testing\PsxResponse => $this->psx->send(
            new Request('POST', $this->psx->path('posts.edit', 'savePost', [
                'id' => 7,
            ]), [
                ...$this->psx->protocol($this->psx->schema('posts.edit', 'savePost')),
                'Content-Type' => 'application/json',
                'X-Pass' => 'group,save',
            ], $body),
        );

        $send('{"title":"a","title":"b","version":3}')->assertProblem(400, execution: 'not-entered');
        $send('[]')->assertProblem(400, execution: 'not-entered');
        $send('{"title":')->assertProblem(400, execution: 'not-entered');
        $send('{"title":"ok","version":3,"__proto__":{"x":1}}')->assertOk();
        self::assertSame(['savePost'], $this->posts->ran);
    }

    public function testAFormCarriesTheSameBody(): void
    {
        $saved = $this->psx
            ->form('posts.edit', 'savePost', ['id' => 7], [['title', 'By form'], ['version', '3']])
            ->assertOk();
        self::assertSame('By form', $saved->data()['title']);

        $this->psx->form(
            'posts.edit',
            'savePost',
            ['id' => 7],
            [['title', 'a'], ['title', 'b'], ['version', '4']],
        )->assertProblem(400, execution: 'not-entered');
    }

    public function testAValueThatIsNotWhatItsTypeSaysIsNeverSent(): void
    {
        $broken = $this->psx->query('posts.edit', 'broken', ['id' => 7]);

        $broken->assertProblem(500, 'server_error');
        self::assertStringNotContainsString((string) PHP_INT_MAX, (string) $broken->response->getBody());
    }

    public function testAServiceIsMountedOncePerDeclarationAndTakesItsOwnPath(): void
    {
        $direct = $this->psx->query('people', 'searchPeople', [], ['query' => 'Ada'])->assertOk();
        $scoped = $this->psx->query('orgPeople', 'searchPeople', ['org' => 'acme'], ['query' => 'Grace'])->assertOk();

        self::assertSame([['name' => 'Ada Lovelace']], $direct->data()['people']);
        self::assertSame([['name' => 'Grace Lovelace']], $scoped->data()['people']);
        self::assertNotSame($this->psx->path('people', 'searchPeople'), $this->psx->path('orgPeople', 'searchPeople', [
            'org' => 'acme',
        ]));
    }

    public function testAnOrdinaryRouteKeepsItsOwnAnswersAndErrors(): void
    {
        $plain = $this->psx->send(new Request('GET', '/plain'));
        $missing = $this->psx->send(new Request('GET', '/nowhere', ['Accept' => 'application/json']));

        self::assertSame('{"plain":true}', (string) $plain->response->getBody());
        self::assertSame('{"error":{"status":404,"message":"Not Found"}}', (string) $missing->response->getBody());
        self::assertNull($missing->kind());
    }

    public function testAPageWithoutPhpIsServedWithNoData(): void
    {
        $home = $this->psx->navigate('/')->assertOk();

        self::assertNull($home->data(0));
        self::assertSame('home:', $home->envelope['nodes'][0]['key']);
    }
}
