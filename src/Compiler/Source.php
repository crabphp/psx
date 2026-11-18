<?php

declare(strict_types=1);

namespace Crab\Psx\Compiler;

use Crab\Psx\PsxException;

/**
 * One .psx file taken apart: the PHP of its <script lang="php"> block
 * as a file of its own, in the module's namespace, and the TSX below it
 * with the PHP blanked out. Both keep the lines of the file, so a line
 * in either is the same line in the source.
 *
 * The file is split by PHP's own lexer, which knows a "</script>" inside
 * a string, a comment or a heredoc from the one that ends the block.
 * Nothing of the file is run.
 *
 * @internal
 */
final readonly class Source
{
    /**
     * The namespace every module's is inside.
     */
    public const string ROOT = 'Psx\\App';

    /**
     * What starts the PHP block, on line 1, and what ends it.
     */
    public const string OPEN = '<script lang="php">';

    public const string CLOSE = '</script>';

    /**
     * @param string $file The file, relative to the application.
     * @param string $id The module's id: its path inside the resources folder, without ".psx".
     * @param string $namespace The namespace its PHP is compiled into.
     * @param string|null $php The compiled PHP file; null for a file with no PHP block.
     * @param string $tsx The TSX, on the lines it had in the file, with line 1 left empty for the bindings' import.
     * @param array<string, string> $uses The classes its PHP imports, by the name it uses them under.
     * @param list<string> $declared The classes, enums and interfaces its PHP declares.
     * @param bool $server Whether it declares the Server class.
     */
    private function __construct(
        public string $file,
        public string $id,
        public string $namespace,
        public ?string $php,
        public string $tsx,
        public array $uses,
        public array $declared,
        public bool $server,
    ) {}

    /**
     * @param string $resources The resources folder, relative to the application: "resources".
     * @param string $root The namespace the module's own is inside.
     */
    public static function parse(string $file, string $code, string $resources, string $root = self::ROOT): self
    {
        $prefix = rtrim($resources, '/') . '/';
        if (!str_starts_with($file, $prefix)) {
            throw new PsxException("A .psx file lives in the {$resources} folder, \"psx.resources\".", $file);
        }
        $id = substr($file, strlen($prefix), -strlen('.psx'));
        $namespace = $root;
        foreach (explode('/', $id) as $segment) {
            $word = preg_replace('/[^A-Za-z0-9_]/', '_', $segment);
            if ($word === '' || $word === null) {
                throw new PsxException('The file\'s path has an empty part.', $file);
            }
            $namespace .= '\\' . (ctype_digit($word[0]) ? '_' . $word : $word);
        }
        [$region, $end, $open] = self::split($code, $file);
        if ($region === null) {
            return new self($file, $id, $namespace, null, "\n" . $code, [], [], false);
        }
        [$uses, $declared, $blank] = self::scan($region, $file);
        $tsx = substr($code, $end);
        foreach (['<?php', '<?=', self::OPEN] as $needle) {
            $again = strpos($tsx, $needle);
            if ($again !== false) {
                throw new PsxException(
                    "There is PHP after the \"</script>\" that ends the PHP block. Everything below it is TSX, which the browser is given; a \"{$needle}\" in a string there is written in two parts.",
                    $file,
                    substr_count($code, "\n", 0, $end + $again) + 1,
                );
            }
        }
        $php = '';
        foreach ($region as $token) {
            // A declare(strict_types=1) of the file's own gives way to the compiled file's, on the same line.
            $php .= isset($blank[$token->pos]) ? str_repeat(' ', strlen($token->text)) : $token->text;
        }
        return new self(
            $file,
            $id,
            $namespace,
            "<?php declare(strict_types=1); namespace {$namespace};" . substr($open, strlen('<?php')) . $php,
            // Line 1 is left for the import of the module's bindings.
            str_repeat("\n", substr_count($code, "\n", 0, $end)) . $tsx,
            $uses,
            $declared,
            in_array('Server', $declared, true),
        );
    }

    /**
     * The PHP block of a .psx file as it is written, or null for a file
     * without one.
     */
    public static function region(string $code, string $file = ''): ?string
    {
        [$region, $end] = self::split($code, $file);
        return $region === null ? null : substr($code, 0, $end);
    }

    /**
     * Finds the PHP block: '<script lang="php">' at the very start of the
     * file, up to the first "</script>" that PHP's own lexer reads as
     * code, so one in a string, a comment or a heredoc does not end it.
     *
     * @return array{?list<\PhpToken>, int, string} The tokens of the block without its opening tag, where the TSX
     *     starts in the file, and the opening tag the compiled file begins with.
     */
    private static function split(string $code, string $file): array
    {
        if (!str_starts_with($code, self::OPEN)) {
            if (str_starts_with(ltrim($code), '<?php')) {
                throw new PsxException(
                    'The PHP of a .psx file is written in a <script lang="php"> block, no longer between "<?php" and "?>": '
                    . 'put <script lang="php"> in place of the "<?php" on line 1 and </script> in place of the "?>".',
                    $file,
                    1,
                );
            }
            $at = strpos($code, self::OPEN);
            if ($at !== false || str_starts_with(ltrim($code), '<script')) {
                throw new PsxException(
                    'The PHP block must be the first thing in the file: <script lang="php"> at the start of line 1, with nothing before it and no other attributes, the TSX after its </script>.',
                    $file,
                    $at === false ? 1 : substr_count($code, "\n", 0, $at) + 1,
                );
            }
            return [null, 0, ''];
        }
        // The block, read as PHP: the opening tag takes the place of <script lang="php"> on line 1, so lines stay.
        $source = '<?php ' . substr($code, strlen(self::OPEN));
        $offset = strlen(self::OPEN) - strlen('<?php ');
        $tokens = \PhpToken::tokenize($source);
        $close = null;
        foreach ($tokens as $index => $token) {
            if ($token->id === T_CLOSE_TAG || $token->id === T_INLINE_HTML) {
                throw new PsxException(
                    'The PHP block holds a "?>". It is ended by </script> alone; write a "?>" in a string in two parts.',
                    $file,
                    $token->line,
                );
            }
            if ($token->text === '<' && substr($source, $token->pos, strlen(self::CLOSE)) === self::CLOSE) {
                $close = $index;
                break;
            }
        }
        if ($close === null) {
            throw new PsxException(
                'The PHP block is not closed. End it with </script> on a line of its own, after a statement that ends with ";" or "}".',
                $file,
            );
        }
        $end = $tokens[$close]->pos + $offset + strlen(self::CLOSE);
        $rest = strpos($code, "\n", $end);
        if (trim(substr($code, $end, $rest === false ? null : $rest - $end)) !== '') {
            throw new PsxException(
                'The TSX starts on the line after the </script> that ends the PHP block.',
                $file,
                $tokens[$close]->line,
            );
        }
        return [array_slice($tokens, 1, $close - 1), $end, $tokens[0]->text];
    }

    /**
     * Reads the statements of the PHP block: only imports, constants,
     * functions and types may stand there.
     *
     * @param list<\PhpToken> $tokens
     * @return array{array<string, string>, list<string>, array<int, true>} The imports, the declared types, and the positions of tokens to blank.
     */
    private static function scan(array $tokens, string $file): array
    {
        $uses = [];
        $declared = [];
        $blank = [];
        $count = count($tokens);
        $skip = [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT];
        for ($index = 0; $index < $count; ++$index) {
            $token = $tokens[$index];
            if (in_array($token->id, $skip, true)) {
                continue;
            }
            switch ($token->id) {
                case T_USE:
                    $end = self::until($tokens, $index, ';', $file);
                    $uses += self::imports(array_slice($tokens, $index + 1, $end - $index - 1), $file, $token->line);
                    $index = $end;
                    break;
                case T_DECLARE:
                    $end = self::until($tokens, $index, ';', $file);
                    $text = '';
                    for ($at = $index; $at <= $end; ++$at) {
                        $text .= in_array($tokens[$at]->id, $skip, true) ? '' : $tokens[$at]->text;
                        $blank[$tokens[$at]->pos] = true;
                    }
                    if ($text !== 'declare(strict_types=1);') {
                        throw new PsxException(
                            'A .psx file is compiled with declare(strict_types=1); it cannot declare anything else.',
                            $file,
                            $token->line,
                        );
                    }
                    $index = $end;
                    break;
                case T_CONST:
                    $index = self::until($tokens, $index, ';', $file);
                    break;
                case T_ATTRIBUTE:
                    $index = self::matching($tokens, $index, '[', ']', $file);
                    break;
                case T_FUNCTION:
                    $index = self::block($tokens, $index, $file);
                    break;
                case T_FINAL:
                case T_READONLY:
                case T_ABSTRACT:
                case T_CLASS:
                case T_ENUM:
                case T_INTERFACE:
                case T_TRAIT:
                    $modifiers = [];
                    $at = $index;
                    while (in_array($tokens[$at]->id, [T_FINAL, T_READONLY, T_ABSTRACT, ...$skip], true)) {
                        $modifiers[] = $tokens[$at]->id;
                        ++$at;
                    }
                    $name = null;
                    for ($look = $at + 1; $look < $count; ++$look) {
                        if (!in_array($tokens[$look]->id, $skip, true)) {
                            $name = $tokens[$look]->id === T_STRING ? $tokens[$look]->text : null;
                            break;
                        }
                    }
                    if ($name === null) {
                        throw new PsxException('A type declared here needs a name.', $file, $token->line);
                    }
                    if (
                        $name === 'Server'
                        && (
                            $tokens[$at]->id !== T_CLASS
                            || !in_array(T_FINAL, $modifiers, true)
                            || !in_array(T_READONLY, $modifiers, true)
                        )
                    ) {
                        throw new PsxException(
                            'The Server class is declared "final readonly class Server": it is shared by every request a worker serves, and keeps nothing of one.',
                            $file,
                            $token->line,
                        );
                    }
                    if (in_array($name, $declared, true)) {
                        throw new PsxException("{$name} is declared twice.", $file, $token->line);
                    }
                    $declared[] = $name;
                    $index = self::block($tokens, $at, $file);
                    break;
                case T_NAMESPACE:
                    throw new PsxException(
                        'A .psx file declares no namespace: its PHP is compiled into one of its own, so its Server and its types cannot meet another file\'s.',
                        $file,
                        $token->line,
                    );
                default:
                    throw new PsxException(
                        "The PHP block holds imports, constants, functions and types, and \"{$token->text}\" starts a statement that would run when the file is loaded. Put what runs in a method of the Server class.",
                        $file,
                        $token->line,
                    );
            }
        }
        return [$uses, $declared, $blank];
    }

    /**
     * The index of the next token of this text outside any bracket.
     *
     * @param list<\PhpToken> $tokens
     */
    private static function until(array $tokens, int $from, string $text, string $file): int
    {
        $depth = 0;
        for ($index = $from; $index < count($tokens); ++$index) {
            $piece = $tokens[$index]->text;
            if ($depth === 0 && $piece === $text) {
                return $index;
            }
            if ($piece === '(' || $piece === '[' || $piece === '{' || $tokens[$index]->id === T_ATTRIBUTE) {
                ++$depth;
            } elseif ($piece === ')' || $piece === ']' || $piece === '}') {
                --$depth;
            }
        }
        throw new PsxException("A statement is not ended with \"{$text}\".", $file, $tokens[$from]->line);
    }

    /**
     * The index of the bracket that closes the one opened at or after an index.
     *
     * @param list<\PhpToken> $tokens
     */
    private static function matching(array $tokens, int $from, string $open, string $close, string $file): int
    {
        $depth = 0;
        for ($index = $from; $index < count($tokens); ++$index) {
            $token = $tokens[$index];
            $opens =
                $token->text === $open
                || $open === '[' && $token->id === T_ATTRIBUTE
                || $open === '{' && in_array($token->id, [T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES], true);
            if ($opens) {
                ++$depth;
            } elseif ($token->text === $close && --$depth === 0) {
                return $index;
            }
        }
        throw new PsxException("A \"{$open}\" is never closed.", $file, $tokens[$from]->line);
    }

    /**
     * The index of the "}" that ends a function or a type starting at an index.
     *
     * @param list<\PhpToken> $tokens
     */
    private static function block(array $tokens, int $from, string $file): int
    {
        for ($index = $from; $index < count($tokens); ++$index) {
            if ($tokens[$index]->text === '{') {
                return self::matching($tokens, $index, '{', '}', $file);
            }
            if ($tokens[$index]->text === ';') {
                break;
            }
        }
        throw new PsxException('A function or a type here needs a body.', $file, $tokens[$from]->line);
    }

    /**
     * The classes a use statement imports, by the name each is used under.
     *
     * @param list<\PhpToken> $tokens The statement, without "use" and ";".
     * @return array<string, string>
     */
    private static function imports(array $tokens, string $file, int $line): array
    {
        $text = '';
        foreach ($tokens as $token) {
            $text .= in_array($token->id, [T_COMMENT, T_DOC_COMMENT], true) ? '' : $token->text;
        }
        $text = trim((string) preg_replace('/\s+/', ' ', $text));
        if (preg_match('/^(?:function|const) /', $text) === 1) {
            return [];
        }
        $imports = [];
        $prefix = '';
        if (preg_match('/^(.+\\\\)\{(.+)\}$/', $text, $group) === 1) {
            $prefix = trim($group[1]);
            $text = $group[2];
        }
        foreach (explode(',', $text) as $item) {
            $item = trim($item);
            if ($item === '') {
                continue;
            }
            if (preg_match('/^\\\\?([A-Za-z0-9_\\\\]+)(?: as ([A-Za-z0-9_]+))?$/i', $item, $match) !== 1) {
                throw new PsxException("The import \"{$item}\" cannot be read.", $file, $line);
            }
            $class = ltrim($prefix, '\\') . $match[1];
            $imports[$match[2] ?? substr((string) strrchr('\\' . $class, '\\'), 1)] = $class;
        }
        return $imports;
    }
}
