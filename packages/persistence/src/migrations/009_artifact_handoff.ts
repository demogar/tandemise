import type { Migration } from './types.js';

/**
 * The handoff an artifact opens with, its measured length, and whether it
 * stayed over its word budget.
 *
 * `handoff` is JSON because it is payload a card renders, never a predicate.
 * Rows written before the contract existed keep it NULL, and `over_budget`
 * defaults to 0 so they are never flagged for a rule they were not written
 * under.
 *
 * Search has to reach the handoff too: the headline and points are the words a
 * person remembers an artifact by. The FTS5 index is external-content over
 * `artifacts`, which means every indexed column must exist on that table under
 * the same name - FTS reads it back for `rebuild` and for its integrity check.
 * So the text to index is a virtual generated column, `handoff_text`, rather
 * than an expression repeated inside each trigger. SQLite computes it the same
 * way on insert, update, delete and rebuild, which is exactly the property the
 * external-content 'delete' command depends on: it must be handed the values
 * that were indexed, or it corrupts the index. A virtual column occupies no
 * storage and `ALTER TABLE ... ADD COLUMN` accepts it without a table copy.
 *
 * Only the headline, the points and `needs` are joined. JSON keys and link
 * kinds are structure, and indexing them would make a search for "preview"
 * match every artifact that has a preview link. The handoff schema caps points
 * at three, so the first three are all of them. `json_valid` guards the
 * extraction because a hand-edited or truncated column would otherwise make
 * `json_extract` raise, failing the write that touched the row and every
 * search that read it.
 *
 * An FTS5 table cannot gain a column, so it is dropped and recreated with the
 * new one, then rebuilt from `artifacts`. The index holds only terms - the text
 * lives in `artifacts` - so nothing is lost by the drop, and the migration
 * runner wraps all of it in one transaction with the ledger row: an
 * interrupted upgrade leaves the old table and triggers in place.
 */
export const migration009: Migration = {
  version: 9,
  name: 'artifact_handoff',
  up: `
ALTER TABLE artifacts ADD COLUMN handoff TEXT;
ALTER TABLE artifacts ADD COLUMN word_count INTEGER;
ALTER TABLE artifacts ADD COLUMN over_budget INTEGER NOT NULL DEFAULT 0 CHECK (over_budget IN (0,1));
ALTER TABLE artifacts ADD COLUMN handoff_text TEXT GENERATED ALWAYS AS (
  CASE WHEN json_valid(handoff) THEN trim(
    coalesce(json_extract(handoff, '$.headline'), '') || ' ' ||
    coalesce(json_extract(handoff, '$.points[0]'), '') || ' ' ||
    coalesce(json_extract(handoff, '$.points[1]'), '') || ' ' ||
    coalesce(json_extract(handoff, '$.points[2]'), '') || ' ' ||
    coalesce(json_extract(handoff, '$.needs'), '')
  ) END
) VIRTUAL;

DROP TRIGGER artifacts_fts_ai;
DROP TRIGGER artifacts_fts_ad;
DROP TRIGGER artifacts_fts_au;
DROP TABLE artifacts_fts;

CREATE VIRTUAL TABLE artifacts_fts USING fts5 (
  title,
  summary,
  handoff_text,
  content='artifacts',
  content_rowid='rowid'
);

INSERT INTO artifacts_fts (artifacts_fts) VALUES ('rebuild');

CREATE TRIGGER artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts (rowid, title, summary, handoff_text)
  VALUES (new.rowid, new.title, new.summary, new.handoff_text);
END;
CREATE TRIGGER artifacts_fts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts (artifacts_fts, rowid, title, summary, handoff_text)
  VALUES ('delete', old.rowid, old.title, old.summary, old.handoff_text);
END;
CREATE TRIGGER artifacts_fts_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts (artifacts_fts, rowid, title, summary, handoff_text)
  VALUES ('delete', old.rowid, old.title, old.summary, old.handoff_text);
  INSERT INTO artifacts_fts (rowid, title, summary, handoff_text)
  VALUES (new.rowid, new.title, new.summary, new.handoff_text);
END;
`,
};
