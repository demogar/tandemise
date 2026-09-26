import type { PromptSkill, RunSkill, SkillFile, SkillPin } from '@tandemise/domain';
import { SKILL_FILE, parseSkillFrontMatter, skillPromptSection } from '@tandemise/domain';
import type { ExecutionTarget } from '@tandemise/execution-core';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';

/**
 * The first line of the `.gitignore` Tandemise writes into every skill folder
 * it installs. It keeps the folder out of commits on its own, and it is how a
 * folder Tandemise wrote is told apart from the repository's own skill of the
 * same name - which is never overwritten or removed.
 */
export const INSTALLED_MARKER = '# Written by Tandemise: a skill pinned to this run. Never committed.';

/** What installing a run's skills produced. */
export interface InstalledSkills {
  /** What the run received, recorded on its row. */
  readonly received: readonly RunSkill[];
  /** Appended to every fresh prompt of the attempt; null when no skill was pinned. */
  readonly promptSection: string | null;
  /** Folders this attempt wrote, relative to the working folder (removed afterwards from a non-worktree target). */
  readonly written: readonly string[];
}

export const NO_SKILLS: InstalledSkills = { received: [], promptSection: null, written: [] };

/**
 * Puts a run's pinned skills where its runtime reads them (P13 spec §4).
 *
 * `folder` is where the runtime loads skills from (`.claude/skills`), or null
 * when it loads none: then every skill goes into the prompt. Content comes in
 * already verified against its pin's hash; this writes it through the
 * target's scoped filesystem, so it can land nowhere but the working folder.
 */
export class SkillInstaller {
  constructor(private readonly recorder: EventRecorder) {}

  async install(input: {
    readonly target: ExecutionTarget;
    readonly scope: EventScope;
    readonly folder: string | null;
    readonly skills: readonly { readonly pin: SkillPin; readonly files: readonly SkillFile[] }[];
  }): Promise<InstalledSkills> {
    const { target, scope, folder, skills } = input;
    if (skills.length === 0) return NO_SKILLS;
    const fs = target.filesystem();
    const received: RunSkill[] = [];
    const prompt: PromptSkill[] = [];
    const written: string[] = [];

    for (const { pin, files } of skills) {
      const md = files.find((f) => f.path === SKILL_FILE);
      const front = parseSkillFrontMatter(md === undefined ? '' : new TextDecoder().decode(md.bytes));
      const description = front.description ?? '';
      const otherFiles = files.filter((f) => f.path !== SKILL_FILE).map((f) => f.path);
      let via: 'folder' | 'prompt' = folder === null ? 'prompt' : 'folder';

      if (folder !== null) {
        const dir = `${folder}/${pin.name}`;
        const marker = `${dir}/.gitignore`;
        const ours = await fs.exists(marker) && (await fs.read(marker)).startsWith(INSTALLED_MARKER);
        if (await fs.exists(dir) && !ours) {
          // The repository's own skill of that name: never overwritten.
          via = 'prompt';
          this.recorder.note(scope, `The repository already has its own ${dir}; the pinned '${pin.name}' v${pin.version} was given in the prompt instead.`, 'warn');
        } else {
          // A folder from an earlier run may hold an older version: start clean.
          if (await fs.exists(dir)) await fs.remove(dir, { recursive: true });
          await fs.mkdir(dir);
          for (const file of files) {
            const path = `${dir}/${file.path}`;
            const parent = path.slice(0, path.lastIndexOf('/'));
            if (parent !== dir) await fs.mkdir(parent);
            await fs.write(path, file.bytes);
          }
          await fs.write(marker, `${INSTALLED_MARKER}\n# ${pin.name} v${pin.version} ${pin.hash}\n*\n`);
          written.push(dir);
        }
      }

      received.push({ name: pin.name, version: pin.version, hash: pin.hash, via });
      prompt.push({ name: pin.name, version: pin.version, description, via, body: front.body, otherFiles });
    }

    if (written.length > 0) await this.#exclude(target, scope, written);
    return { received, promptSection: skillPromptSection(prompt), written };
  }

  /** Removes what `install` wrote (a non-worktree target is the person's own folder). */
  async remove(target: ExecutionTarget, scope: EventScope, installed: InstalledSkills): Promise<void> {
    const fs = target.filesystem();
    for (const dir of installed.written) {
      try {
        const marker = `${dir}/.gitignore`;
        if (await fs.exists(marker) && (await fs.read(marker)).startsWith(INSTALLED_MARKER)) await fs.remove(dir, { recursive: true });
      } catch (e) {
        this.recorder.note(scope, `Could not remove the skill folder ${dir}: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
    }
  }

  /**
   * Adds each folder to the repository's `info/exclude`, idempotently. Asked
   * of git (`--git-path`) because a worktree's exclude file is the main
   * repository's, not one under the worktree's own git folder. A target that
   * is not a repository has nothing to exclude from; the marker `.gitignore`
   * still keeps the folder out of anything that reads it.
   */
  async #exclude(target: ExecutionTarget, scope: EventScope, dirs: readonly string[]): Promise<void> {
    try {
      const where = await target.exec({ command: 'git', args: ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'] });
      if (where.exitCode !== 0) return;
      const file = where.stdout.trim();
      if (file.length === 0) return;
      for (const dir of dirs) {
        const entry = `/${dir}/`;
        await target.exec({
          command: '/bin/sh',
          args: ['-c', 'mkdir -p "$(dirname "$1")" && { grep -qxF "$2" "$1" 2>/dev/null || printf \'%s\\n\' "$2" >> "$1"; }', 'sh', file, entry],
        });
      }
    } catch (e) {
      this.recorder.note(scope, `Could not exclude the skill folders from git: ${e instanceof Error ? e.message : String(e)}`, 'warn');
    }
  }
}
