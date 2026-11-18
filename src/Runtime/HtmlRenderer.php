<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Psx\Contracts\DocumentRenderer;

/**
 * The document PSX writes where the application binds no renderer of
 * its own: a doctype, the head, the root the page is put in, what it
 * starts from as data no browser runs, and its scripts.
 */
final readonly class HtmlRenderer implements DocumentRenderer
{
    public function render(Document $document): string
    {
        $nonce = $document->nonce === null ? '' : ' nonce="' . self::escape($document->nonce) . '"';
        $head =
            '<meta charset="utf-8">'
            . "\n"
            . '<meta name="viewport" content="width=device-width, initial-scale=1">'
            . "\n";
        $head .= '<title>' . self::escape($document->head->title ?? '') . "</title>\n";
        foreach (['meta' => $document->head->meta, 'link' => $document->head->links] as $tag => $entries) {
            foreach ($entries as $key => $attributes) {
                $head .= "<{$tag} data-psx-head=\"" . self::escape((string) $key) . '"';
                foreach ($attributes as $name => $value) {
                    $head .= " {$name}=\"" . self::escape($value) . '"';
                }
                $head .= ">\n";
            }
        }
        foreach ($document->styles as $style) {
            $head .= '<link rel="stylesheet" href="' . self::escape($style) . "\">\n";
        }
        foreach ($document->preloads as $preload) {
            $head .= '<link rel="modulepreload" href="' . self::escape($preload) . "\">\n";
        }
        $scripts = '';
        if ($document->preamble !== null) {
            $scripts .= "<script type=\"module\"{$nonce}>{$document->preamble}</script>\n";
        }
        foreach ($document->scripts as $script) {
            $scripts .= '<script type="module" src="' . self::escape($script) . "\"{$nonce}></script>\n";
        }
        return (
            "<!doctype html>\n<html lang=\""
            . self::escape($document->lang)
            . "\">\n<head>\n{$head}</head>\n<body>\n"
            . '<div id="app">'
            . ($document->html ?? '')
            . "</div>\n"
            . "<noscript>This page needs JavaScript to show and to save what it holds.</noscript>\n"
            . "<script type=\"application/json\" id=\"psx-bootstrap\">{$document->bootstrap}</script>\n"
            . $scripts
            . "</body>\n</html>\n"
        );
    }

    private static function escape(string $text): string
    {
        return htmlspecialchars($text, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    }
}
