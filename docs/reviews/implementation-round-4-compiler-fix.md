# Round 4 compiler fix: R4-S01

2026-11-15. This answers the one open finding of [implementation-round-4-final-fixes.md](implementation-round-4-final-fixes.md). It awaits the reviewer's re-check; it is not closed by this note. No verdict of an earlier report was edited.

## The finding

`Families::exact()` walks a method's input schema to refuse an integer-backed enum with a case past ±9007199254740991. It took any array under the key `enum` for the list of an enum's cases. A field that is itself named `enum` sits in `properties` under that same key, and its value is the field's schema, a map. The walk looked at that map's own values, found no integer, and did not read further into it: the unsafe enum compiled, and its literal was written into the generated types. Strict binding still refused the value at run time.

## The fix

`src/Compiler/Families.php`, in `exact()`, one condition:

```diff
-            if ($key === 'enum' && is_array($value)) {
+            // The cases of an enum are a list. A map under that key is the schema of a field that is
+            // itself named "enum", and is read through like any other.
+            if ($key === 'enum' && is_array($value) && array_is_list($value)) {
```

A map now falls to the branch that reads into it. Nothing else of the source changed: no framework, client or dependency change.

## Tests

`tests/CompilerTest.php`, two tests and two private helpers (`page()`, `written()`).

`testAnEnumPastWhatABrowserHoldsIsRefusedAlsoWhereWhatTakesItIsNamedEnum`, eight cases. Each must fail compilation with `<method>() takes an enum with the value 9007199254740993`, with `resources/pages/Home.psx` as the exception's source and a line, and with the value nowhere under `.psx/`:

| Case | Declared as |
| --- | --- |
| A field of an action's input | `public Big $enum` |
| A field that may be null | `public ?Big $enum = null` |
| A list of them | `#[ListOf(Big::class)] public array $enum` |
| An input named enum that holds a field named enum | `choose(Outer $enum)`, `Outer { Inner $enum }`, `Inner { Big $enum }` |
| A list named enum of inputs | `#[ListOf(Inner::class)] public array $enum`, `Inner { Big $size }` |
| A query field of a query | `find(#[FromQuery] Big $enum)` |
| A query field of a query that may be null | `find(#[FromQuery] ?Big $enum = null)` |
| A query field of a loader | `load(#[FromQuery] ?Big $enum = null)` |

`testAnEnumABrowserHoldsCompilesWhereWhatTakesItIsNamedEnum`: an integer enum with the cases 1, 9007199254740991 and -9007199254740991, and a string enum one of whose values is the text `'9007199254740993'`, as fields, a nested field, an input and query fields all named `enum`. It compiles and serves, the safe literals are in the generated types, the action and the query are entered with safe values, and a value that is no case and `9007199254740993` in the query string are 422 `not-entered`.

An action cannot take a `#[FromQuery]` parameter (the compiler refuses that for its own reason), so that form is covered by a query and a loader.

## The regression fails without the fix

With the tests in place and `Families.php` as the reviewer hashed it (`31e8dfcadef6098d3e390d72a0576bfd0047f82b394511b92ddf50fcce91ea4b`):

| Command, in `psx/` | Result |
| --- | --- |
| `vendor/bin/phpunit --filter 'IsNamedEnum'` | exit 1: 9 tests, 22 assertions, 8 failures, each "It was compiled."; the compiling test passed. Output in `/tmp/psx-r4-s01-before.log` |

## With the fix

`Families.php` is `ab99c2b552fce9d5d9a260c66509439e32c2abd0eee33dbd72dd3e2ab963e8ab`; `tests/CompilerTest.php` is `d8ffb86fcdf7d2f4bbf80d097da17bdd96d59a9d115591b96b7343a259400919`.

| Command, in `psx/` | Result |
| --- | --- |
| `vendor/bin/phpunit --filter 'IsNamedEnum'` | exit 0: 9 tests, 46 assertions. `/tmp/psx-r4-s01-after.log` |
| `composer test` | exit 0: 173 tests, 1133 assertions (164 and 1087 before) |
| `composer format:check` | exit 0, all files formatted |
| `composer lint` | exit 0, no issues |

Not run for this change, because nothing they cover was touched: the framework suite, the client package's checks, the demo's tests and the browser suite.

`docs/STATUS.md` has the new PHP test count. Nothing was committed or pushed, and the preview on port 8094 was not touched.
