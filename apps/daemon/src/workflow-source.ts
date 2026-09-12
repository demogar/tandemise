import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseWorkflowDefinition } from '@tandemise/domain';
import type { LoadedWorkflow, WorkflowSourcePort } from '@tandemise/application';
import { errorMessage, type Logger } from '@tandemise/shared';

/** Where a project keeps its workflows, relative to each repository root. */
const WORKFLOW_DIR = join('.tandemise', 'workflows');
const EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

/**
 * Reads workflow files out of the project's repositories.
 *
 * They live in the repository rather than in Tandemise's database on purpose: a
 * process belongs next to the code it describes. It is versioned with that
 * code, it arrives on a new machine with a clone, a change to it shows up in a
 * diff and can be reviewed like any other change, and a branch can carry a
 * different one while an experiment is in flight. None of that is true of a row
 * in a local database.
 *
 * A malformed file is reported, never skipped. Silently omitting it would mean
 * the workflow simply does not appear, which sends the author looking in
 * exactly the wrong place.
 */
export class FileWorkflowSource implements WorkflowSourcePort {
  constructor(private readonly log: Logger) {}

  async list(repositoryPaths: readonly string[]): Promise<readonly LoadedWorkflow[]> {
    const found = new Map<string, LoadedWorkflow>();

    for (const root of repositoryPaths) {
      const dir = join(root, WORKFLOW_DIR);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        // No workflows in this repository, which is the normal case.
        continue;
      }

      for (const entry of entries.sort()) {
        if (!EXTENSIONS.has(extname(entry))) continue;
        const path = join(dir, entry);
        const id = basename(entry, extname(entry));
        // First repository listed wins, so a project with several repositories
        // has one obvious place to put a shared workflow.
        if (found.has(id)) continue;
        found.set(id, await this.#load(id, path));
      }
    }

    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async #load(id: string, path: string): Promise<LoadedWorkflow> {
    let raw: unknown;
    try {
      const text = await readFile(path, 'utf8');
      // YAML is a superset of JSON, so one parser covers both extensions.
      raw = parseYaml(text);
    } catch (error) {
      this.log.warn('workflow.unreadable', { path, error: errorMessage(error) });
      return { id, path, definition: null, issues: [{ path: '(file)', message: errorMessage(error) }] };
    }

    const parsed = parseWorkflowDefinition(raw);
    return parsed.ok
      ? { id, path, definition: parsed.value, issues: [] }
      : { id, path, definition: null, issues: parsed.error };
  }
}
