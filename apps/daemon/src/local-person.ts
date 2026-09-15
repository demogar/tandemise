import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import type { Logger } from '@tandemise/shared';
import type { TandemiseServices } from '@tandemise/application';

/** `git config --global user.name`, or undefined when git is missing, slow or unset. */
export function gitUserName(): string | undefined {
  try {
    const name = execFileSync('git', ['config', '--global', 'user.name'], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Names the local person from git, once.
 *
 * Migration 008 cannot run processes, so it names the person after the OS user
 * (or a placeholder). Only those generated names are replaced: a name the user
 * picked, or one set through `TANDEMISE_OWNER_NAME`, is theirs and stays.
 */
export function adoptGitName(services: TandemiseServices, gitName: string | undefined, log: Logger): void {
  if (gitName === undefined) return;
  try {
    const person = services.identity.localPerson();
    if (person.displayName === gitName || !generatedNames().has(person.displayName)) return;
    services.team.updatePerson({ personId: person.id }, person.id, { displayName: gitName });
    log.info('identity.local_person_named', { personId: person.id });
  } catch (e) {
    // A nicer name is not worth refusing to start over, e.g. when the local person was removed.
    log.warn('identity.local_person_name_skipped', { error: e instanceof Error ? e.message : String(e) });
  }
}

function generatedNames(): ReadonlySet<string> {
  // 'You' is the identity default, 'Owner' the migration's last resort.
  const names = new Set(['You', 'Owner']);
  try {
    const os = userInfo().username;
    if (os) names.add(os);
  } catch {
    // No passwd entry, as in some containers: nothing more to recognise.
  }
  const chosen = process.env.TANDEMISE_OWNER_NAME?.trim();
  if (chosen) names.delete(chosen);
  return names;
}
