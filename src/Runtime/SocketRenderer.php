<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Engine\EventLoop;
use Crab\Http\HttpException;
use Crab\Psx\Contracts\RendererTransport;

/**
 * Asks the release's own renderer, a Node process on this machine, for a
 * page's HTML over a private Unix socket. It is sent the page's envelope
 * and the release's id and nothing else: no request, no cookie, no path
 * of a module. One exchange is one connection, bounded in bytes and in
 * time; a renderer that is slow, gone or of another release is a 503,
 * never a page quietly left for the browser to render.
 *
 * A message is its length in four bytes, then JSON.
 */
final class SocketRenderer implements RendererTransport
{
    private int $inflight = 0;

    /**
     * The longest it takes to connect to the renderer and be told so, all
     * of it, in seconds.
     */
    private const float HOLD_SECONDS = 0.25;

    /**
     * What is answered to that is a few bytes.
     */
    private const int HOLD_ANSWER_BYTES = 256;

    /**
     * The connection this worker keeps to the renderer for as long as it
     * may ask it for a page: a renderer told to stop serves until the
     * last such connection is gone.
     *
     * @var resource|null
     */
    private $held = null;

    /**
     * Whether the server this worker is of runs the renderer, and asked
     * for the connection to be kept. A renderer run by somebody else is
     * asked for pages and nothing more.
     */
    private bool $kept = false;

    private bool $connecting = false;

    private float $heldTried = 0.0;

    public function __construct(
        private readonly string $socket,
        private readonly string $build,
        private readonly float $timeout = 5.0,
        private readonly int $maxRequestBytes = 3_145_728,
        private readonly int $maxHtmlBytes = 4_194_304,
        private readonly int $maxInflight = 16,
    ) {}

    public function render(array $envelope, ?string $nonce = null): string
    {
        if ($this->kept && !$this->connecting && !$this->holding() && (microtime(true) - $this->heldTried) >= 1.0) {
            // A renderer that was started again knows nothing of this worker: it is told, a second
            // apart at the least, and in no more time than a page is given.
            $this->connect(min(self::HOLD_SECONDS, $this->timeout));
        }
        $answer = $this->exchange([
            'protocol' => Protocol::VERSION,
            'build' => $this->build,
            'envelope' => $envelope,
            // Only what a nonce is made of: it is written into markup by the renderer.
            ...($nonce !== null && preg_match('~^[A-Za-z0-9+/_=-]{1,256}$~D', $nonce) === 1 ? ['nonce' => $nonce] : []),
        ]);
        if (($answer['ok'] ?? false) !== true || !is_string($answer['html'] ?? null)) {
            throw new HttpException(503, 'The page could not be rendered: ' . self::reason($answer));
        }
        return $answer['html'];
    }

    public function ready(): bool
    {
        try {
            return (
                (
                    $this->exchange(['protocol' => Protocol::VERSION, 'build' => $this->build, 'ping' => true])['ok']
                    ?? false
                ) === true
            );
        } catch (HttpException) {
            return false;
        }
    }

    /**
     * Tells the renderer that this worker may ask it for pages, and stays
     * connected to it: true once it is. Asked for by the server that runs
     * the renderer, of each of its workers as it starts, which is also
     * how the worker knows the renderer is there; from then on the
     * connection is made again when the renderer was. It takes $within
     * seconds at the most, whatever the renderer does, and waits as a
     * request for a page does: nothing else of this worker is held up.
     */
    public function hold(float $within = self::HOLD_SECONDS): bool
    {
        $this->kept = true;
        return $this->holding() || $this->connect($within);
    }

    /**
     * Lets go of the renderer: the worker has stopped and asks for no more pages.
     */
    public function release(): void
    {
        $this->kept = false;
        if (is_resource($this->held)) {
            fclose($this->held);
        }
        $this->held = null;
    }

    private function holding(): bool
    {
        return is_resource($this->held) && !feof($this->held);
    }

    private function connect(float $within): bool
    {
        if ($this->connecting) {
            // One at a time: whoever else renders meanwhile does not try as well.
            return false;
        }
        $this->connecting = true;
        $this->heldTried = microtime(true);
        $deadline = $this->heldTried + $within;
        if (is_resource($this->held)) {
            fclose($this->held);
        }
        $this->held = null;
        $stream = false;
        try {
            if ($within <= 0 || is_link($this->socket) || !file_exists($this->socket)) {
                return false;
            }
            // Not waited for: a socket of this machine is connected to at once, or not at all.
            $stream = @stream_socket_client(
                "unix://{$this->socket}",
                $code,
                $error,
                $within,
                STREAM_CLIENT_CONNECT | STREAM_CLIENT_ASYNC_CONNECT,
            );
            if ($stream === false) {
                return false;
            }
            stream_set_blocking($stream, false);
            $body = json_encode([
                'protocol' => Protocol::VERSION,
                'build' => $this->build,
                'hold' => true,
            ], JSON_THROW_ON_ERROR);
            $out = pack('N', strlen($body)) . $body;
            while ($out !== '') {
                $this->wait($stream, write: true, deadline: $deadline);
                $written = @fwrite($stream, $out);
                if ($written === false) {
                    return false;
                }
                $out = substr($out, $written);
            }
            $in = '';
            $length = null;
            while ($length === null || strlen($in) < ($length + 4)) {
                $this->wait($stream, write: false, deadline: $deadline);
                $chunk = fread($stream, 4 + self::HOLD_ANSWER_BYTES - strlen($in));
                if ($chunk === false || $chunk === '' && feof($stream)) {
                    return false;
                }
                $in .= $chunk;
                if ($length === null && strlen($in) >= 4) {
                    $length = unpack('N', $in)[1];
                    if ($length > self::HOLD_ANSWER_BYTES) {
                        return false;
                    }
                }
            }
            // The one message, whole, and nothing after it.
            $answer = strlen($in) === ($length + 4) ? json_decode(substr($in, 4), true) : null;
            if (!is_array($answer) || ($answer['ok'] ?? false) !== true) {
                return false;
            }
            $this->held = $stream;
            $stream = false;
            return true;
        } catch (HttpException) {
            // It took longer than it may.
            return false;
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
            $this->connecting = false;
        }
    }

    /**
     * @param array<string, mixed> $message
     * @return array<string, mixed>
     */
    private function exchange(array $message): array
    {
        $body = json_encode($message, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (strlen($body) > $this->maxRequestBytes) {
            throw new HttpException(
                503,
                "The page's data is over the renderer's {$this->maxRequestBytes} bytes, \"psx.ssr.max_request_bytes\".",
            );
        }
        if ($this->inflight >= $this->maxInflight) {
            throw new HttpException(503, 'The renderer is busy.', ['Retry-After' => '1']);
        }
        if (is_link($this->socket) || !file_exists($this->socket)) {
            throw new HttpException(503, 'The renderer is not running.');
        }
        ++$this->inflight;
        $deadline = microtime(true) + $this->timeout;
        $stream = @stream_socket_client("unix://{$this->socket}", $code, $error, $this->timeout);
        try {
            if ($stream === false) {
                throw new HttpException(503, 'The renderer is not running.');
            }
            stream_set_blocking($stream, false);
            $out = pack('N', strlen($body)) . $body;
            while ($out !== '') {
                $this->wait($stream, write: true, deadline: $deadline);
                $written = @fwrite($stream, $out);
                if ($written === false) {
                    throw new HttpException(503, 'The renderer closed the connection.');
                }
                $out = substr($out, $written);
            }
            $in = '';
            $length = null;
            while ($length === null || strlen($in) < ($length + 4)) {
                $this->wait($stream, write: false, deadline: $deadline);
                $chunk = fread($stream, 65_536);
                if ($chunk === false || $chunk === '' && feof($stream)) {
                    throw new HttpException(503, 'The renderer closed the connection.');
                }
                $in .= $chunk;
                if ($length === null && strlen($in) >= 4) {
                    $length = unpack('N', $in)[1];
                    // The HTML, and what little is said beside it.
                    if ($length > (($this->maxHtmlBytes * 2) + 4_096)) {
                        throw new HttpException(
                            503,
                            "The rendered page is over {$this->maxHtmlBytes} bytes, \"psx.ssr.max_html_bytes\".",
                        );
                    }
                }
            }
            $answer = json_decode(substr($in, 4, $length), true);
            if (!is_array($answer)) {
                throw new HttpException(503, 'The renderer answered what cannot be read.');
            }
            if (is_string($answer['html'] ?? null) && strlen($answer['html']) > $this->maxHtmlBytes) {
                throw new HttpException(
                    503,
                    "The rendered page is over {$this->maxHtmlBytes} bytes, \"psx.ssr.max_html_bytes\".",
                );
            }
            return $answer;
        } finally {
            --$this->inflight;
            if (is_resource($stream)) {
                fclose($stream);
            }
        }
    }

    /**
     * Waits until the socket can be read or written, without holding up
     * the other requests of this worker.
     *
     * @param resource $stream
     */
    private function wait($stream, bool $write, float $deadline): void
    {
        $left = $deadline - microtime(true);
        if ($left <= 0) {
            throw new HttpException(503, 'The renderer took longer than "psx.ssr.timeout_seconds".');
        }
        $loop = EventLoop::current();
        if (!$loop->isRunning()) {
            $read = $write ? [] : [$stream];
            $writes = $write ? [$stream] : [];
            $except = [];
            if (@stream_select($read, $writes, $except, (int) $left, (int) (($left - (int) $left) * 1_000_000)) === 0) {
                throw new HttpException(503, 'The renderer took longer than "psx.ssr.timeout_seconds".');
            }
            return;
        }
        $suspension = $loop->getSuspension();
        $watcher = $write
            ? $loop->onWritable($stream, static fn() => $suspension->resume(true))
            : $loop->onReadable($stream, static fn() => $suspension->resume(true));
        $timer = $loop->delay($left, static fn() => $suspension->resume(false));
        try {
            $ready = $suspension->suspend();
        } finally {
            $loop->cancel($watcher);
            $loop->cancel($timer);
        }
        if ($ready !== true) {
            throw new HttpException(503, 'The renderer took longer than "psx.ssr.timeout_seconds".');
        }
    }

    /**
     * @param array<string, mixed> $answer
     */
    private static function reason(array $answer): string
    {
        $error = $answer['error'] ?? null;
        return is_string($error) ? substr($error, 0, 200) : 'the renderer gave no reason.';
    }
}
