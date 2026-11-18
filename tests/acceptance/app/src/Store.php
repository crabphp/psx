<?php

declare(strict_types=1);

namespace Acceptance;

/**
 * What the acceptance application keeps, in one SQLite file: which
 * revision of signing in and out each browser has reached, the
 * credentials issued, and a little data of each account's own.
 *
 * A credential and the revision it belongs to are written as one
 * transaction, so that no reader sees one without the other.
 */
final class Store
{
    /**
     * One connection for each worker process: nothing of a request is kept on it.
     */
    private static ?\PDO $pdo = null;

    public function pdo(): \PDO
    {
        if (self::$pdo !== null) {
            return self::$pdo;
        }
        $pdo = new \PDO('sqlite:' . storage_path('acceptance.sqlite'));
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = 5000');
        $pdo->exec('CREATE TABLE IF NOT EXISTS browsers (context TEXT PRIMARY KEY, revision INTEGER NOT NULL)');
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS credentials (token TEXT PRIMARY KEY, context TEXT NOT NULL, revision INTEGER NOT NULL, account TEXT NOT NULL)',
        );
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS notes (account TEXT PRIMARY KEY, text TEXT NOT NULL, version INTEGER NOT NULL)',
        );
        $pdo->exec('CREATE TABLE IF NOT EXISTS boxes (box TEXT PRIMARY KEY, count INTEGER NOT NULL)');
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS writes (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT NOT NULL, account TEXT NOT NULL, detail TEXT NOT NULL)',
        );
        return self::$pdo = $pdo;
    }

    public function revision(string $context): int
    {
        $found = $this->pdo()->prepare('SELECT revision FROM browsers WHERE context = ?');
        $found->execute([$context]);
        return (int) $found->fetchColumn();
    }

    /**
     * Whose credential this is, when it is this browser's and of the revision the browser has
     * reached: one of an earlier revision is nobody's.
     */
    public function account(string $context, string $token): ?string
    {
        if ($token === '') {
            return null;
        }
        $found = $this->pdo()->prepare(
            'SELECT c.account FROM credentials c JOIN browsers b ON b.context = c.context AND b.revision = c.revision WHERE c.token = ? AND c.context = ?',
        );
        $found->execute([$token, $context]);
        $account = $found->fetchColumn();
        return is_string($account) ? $account : null;
    }

    /**
     * Signs a browser in as an account, or out with none, if it is still at the revision the page
     * saw: the comparison, the raised revision and the credential are one transaction. A browser
     * that has moved on is left as it is.
     *
     * @return array{bool, ?string} Whether it changed, and the new credential.
     */
    public function change(string $context, int $seen, ?string $account): array
    {
        $pdo = $this->pdo();
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            $pdo->prepare('INSERT OR IGNORE INTO browsers (context, revision) VALUES (?, 0)')->execute([$context]);
            $raised = $pdo->prepare('UPDATE browsers SET revision = revision + 1 WHERE context = ? AND revision = ?');
            $raised->execute([$context, $seen]);
            if ($raised->rowCount() !== 1) {
                $pdo->exec('ROLLBACK');
                return [false, null];
            }
            $pdo->prepare('DELETE FROM credentials WHERE context = ?')->execute([$context]);
            $token = null;
            if ($account !== null) {
                $token = bin2hex(random_bytes(16));
                $pdo
                    ->prepare(
                        'INSERT INTO credentials (token, context, revision, account) SELECT ?, context, revision, ? FROM browsers WHERE context = ?',
                    )
                    ->execute([$token, $account, $context]);
            }
            $pdo->exec('COMMIT');
            return [true, $token];
        } catch (\Throwable $failed) {
            $pdo->exec('ROLLBACK');
            throw $failed;
        }
    }

    /**
     * @return array{text: string, version: int}
     */
    public function note(string $account): array
    {
        $found = $this->pdo()->prepare('SELECT text, version FROM notes WHERE account = ?');
        $found->execute([$account]);
        $row = $found->fetch(\PDO::FETCH_ASSOC);
        return is_array($row)
            ? ['text' => (string) $row['text'], 'version' => (int) $row['version']]
            : ['text' => "the first note of {$account}", 'version' => 0];
    }

    public function write(string $account, string $text): int
    {
        $this->pdo()
            ->prepare(
                'INSERT INTO notes (account, text, version) VALUES (?, ?, 1) ON CONFLICT (account) DO UPDATE SET text = excluded.text, version = version + 1',
            )
            ->execute([$account, $text]);
        $this->record('note', $account, $text);
        return $this->note($account)['version'];
    }

    public function count(string $box): int
    {
        $found = $this->pdo()->prepare('SELECT count FROM boxes WHERE box = ?');
        $found->execute([$box]);
        return (int) $found->fetchColumn();
    }

    public function add(string $box): int
    {
        $this->pdo()
            ->prepare(
                'INSERT INTO boxes (box, count) VALUES (?, 1) ON CONFLICT (box) DO UPDATE SET count = count + 1',
            )
            ->execute([$box]);
        return $this->count($box);
    }

    /**
     * Writes down that an action ran, for a test to count: nothing is ever sent twice.
     */
    public function record(string $what, string $account, string $detail = ''): void
    {
        $this->pdo()
            ->prepare('INSERT INTO writes (what, account, detail) VALUES (?, ?, ?)')
            ->execute([$what, $account, $detail]);
    }
}
