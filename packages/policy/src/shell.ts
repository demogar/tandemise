import { maxRisk, type RiskClass } from '@tandemise/domain';
import { isPathInside } from '@tandemise/shared';
import { absolutePath } from './scope.js';

/**
 * Shell command risk classification (MVP.md §19.2: "risky command patterns may
 * require approval").
 *
 * The design constraint here is *precision*, not coverage. A classifier that
 * flags everything trains the user to approve without reading, which is worse
 * than no classifier at all. So the rules below only fire on commands that are
 * genuinely irreversible or that reach outside the worker's own workspace:
 * `rm -rf node_modules` in the worktree is ordinary work; `rm -rf ~/Documents`
 * is not, and the only difference is where the path resolves to.
 *
 * This is a heuristic layer, not a sandbox. The real containment is the
 * execution target (worktree / container) plus the filesystem scope on the
 * grant. This exists so that the cases which slip past both still surface to a
 * human before they run.
 */
export interface ShellContext {
  /** Directories the worker legitimately owns - worktree, artifact root, tmp. */
  readonly writableRoots: readonly string[];
  /** Relative operands resolve against this. Normally the worktree root. */
  readonly cwd: string;
  /** Branches whose history other people depend on. */
  readonly protectedBranches?: readonly string[];
}

export interface ShellRiskMatch {
  /** Stable rule id, so the UI and the event log can group repeat offenders. */
  readonly rule: string;
  readonly risk: RiskClass;
  readonly detail: string;
  /** The single command the rule fired on, not the whole line. */
  readonly segment: string;
}

export interface ShellClassification {
  readonly risk: RiskClass;
  readonly reason: string;
  readonly matches: readonly ShellRiskMatch[];
}

export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = [
  'main', 'master', 'develop', 'development', 'trunk', 'release', 'production', 'staging',
];

const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'httpie', 'http']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'ruby', 'perl', 'php', 'osascript']);
const WRAPPERS = new Set(['env', 'command', 'nice', 'ionice', 'nohup', 'time', 'xargs', 'stdbuf', 'exec', 'builtin']);
const PRIVILEGE = new Set(['sudo', 'doas', 'su', 'pkexec']);
const REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm']);
const READERS = new Set(['cat', 'bat', 'less', 'more', 'head', 'tail', 'strings', 'xxd', 'od', 'base64', 'cp', 'grep', 'rg', 'awk', 'sed', 'open', 'pbcopy']);

const READ_ONLY_COMMANDS = new Set([
  'ls', 'pwd', 'which', 'whoami', 'echo', 'printf', 'date', 'uname', 'hostname',
  'find', 'file', 'stat', 'wc', 'sort', 'uniq', 'diff', 'tree', 'du', 'df', 'ps', 'top',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'branch', 'remote', 'config', 'rev-parse',
  'ls-files', 'describe', 'shortlog', 'stash', 'worktree',
]);

/**
 * Credential material. These fire wherever they live: an `id_rsa` that happens
 * to sit inside the worktree is still a private key.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.ssh\//i,
  /(^|\/)\.aws\/credentials/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.config\/gh\//i,
  /(^|\/)\.kube\/config$/i,
  /(^|\/)\.gnupg\//i,
  /(^|\/)Library\/Keychains\//i,
  /\.(pem|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
];

/** Secret-bearing files that are only suspicious when read from outside the workspace. */
const CONTEXTUAL_CREDENTIAL_PATTERNS: readonly RegExp[] = [/(^|\/)\.env(\..+)?$/i];

export function classifyShellCommand(command: string, ctx: ShellContext): ShellClassification {
  const matches: ShellRiskMatch[] = [];
  for (const pipeline of splitPipelines(command)) {
    matches.push(...classifyPipeline(pipeline, ctx));
  }

  if (matches.length === 0) {
    // Unrecognised commands are treated as reversible local work rather than as
    // reads: a grant for `shell.exec` is already scoped to the worktree, and
    // assuming "read" would let an unknown mutating command through unnoticed.
    return { risk: 'write_reversible', reason: 'no risky pattern matched', matches: [] };
  }
  const risk = matches.reduce<RiskClass>((acc, m) => maxRisk(acc, m.risk), 'read');
  const worst = matches.filter((m) => m.risk === risk);
  return { risk, reason: worst.map((m) => m.detail).join('; '), matches };
}

// ------------------------------------------------------------------ pipelines

interface Pipeline {
  readonly raw: string;
  readonly commands: readonly Word[][];
}

type Word = { readonly text: string; readonly quoted: boolean };

function classifyPipeline(pipeline: Pipeline, ctx: ShellContext): ShellRiskMatch[] {
  const matches: ShellRiskMatch[] = [];

  // `curl … | sh` - remote code execution with no chance to inspect what runs.
  const heads = pipeline.commands.map((c) => headOf(c));
  const downloaderAt = heads.findIndex((h) => h !== undefined && DOWNLOADERS.has(h.name));
  const interpreterAt = heads.findIndex((h) => h !== undefined && INTERPRETERS.has(h.name));
  if (downloaderAt !== -1 && interpreterAt > downloaderAt) {
    matches.push({
      rule: 'remote-code-execution',
      risk: 'destructive',
      detail: 'pipes downloaded content directly into an interpreter',
      segment: pipeline.raw,
    });
  }
  if (/\b(sh|bash|zsh|python3?|node|ruby|perl)\s+[<$]\(\s*(curl|wget)\b/.test(pipeline.raw)) {
    matches.push({
      rule: 'remote-code-execution',
      risk: 'destructive',
      detail: 'executes the output of a network fetch via process substitution',
      segment: pipeline.raw,
    });
  }

  for (const words of pipeline.commands) {
    matches.push(...classifyCommand(words, ctx));
  }
  return matches;
}

interface Head {
  readonly name: string;
  /** Operands and flags following the command name, wrappers already stripped. */
  readonly args: readonly Word[];
  readonly privileged: boolean;
}

/**
 * Git global options that consume the FOLLOWING word. `git -C /elsewhere push`
 * has `push` in third position, so a naive "first non-flag operand" reads
 * `/elsewhere` as the subcommand and the rule never fires. The `--opt=value`
 * spelling needs no entry here because it stays flag-shaped.
 */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** The git subcommand, skipping global options and any values they consume. */
export function gitSubcommand(args: readonly Word[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (GIT_VALUE_OPTIONS.has(text)) { i++; continue; }
    if (text.startsWith('-')) continue;
    return text;
  }
  return undefined;
}

/** Skips `FOO=bar`, `sudo`, `env`, `xargs`… to find the command actually being run. */
function headOf(words: readonly Word[]): Head | undefined {
  let i = 0;
  let privileged = false;
  while (i < words.length) {
    const w = words[i]!;
    if (!w.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) { i++; continue; }
    const name = basename(w.text);
    if (PRIVILEGE.has(name)) { privileged = true; i++; continue; }
    if (WRAPPERS.has(name)) { i++; continue; }
    if (name.startsWith('-')) { i++; continue; }
    return { name, args: words.slice(i + 1), privileged };
  }
  return undefined;
}

function classifyCommand(words: readonly Word[], ctx: ShellContext): ShellRiskMatch[] {
  const head = headOf(words);
  if (!head) return [];
  const segment = words.map((w) => w.text).join(' ');
  const out: ShellRiskMatch[] = [];

  // Redirection belongs to the shell rather than to the command, so it is
  // scanned over the raw words before any rule runs.
  out.push(...redirectionWrites(words, ctx, segment));

  if (head.privileged) {
    out.push({
      rule: 'privilege-escalation',
      risk: 'destructive',
      detail: 'runs with elevated privileges, escaping every workspace boundary',
      segment,
    });
  }

  const rule = RULES[head.name];
  if (rule) out.push(...rule(head, ctx, segment));

  if (READERS.has(head.name)) out.push(...credentialReads(head, ctx, segment));

  if (out.length === 0 && (READ_ONLY_COMMANDS.has(head.name) || isReadOnlyGit(head))) {
    out.push({ rule: 'read-only', risk: 'read', detail: `${head.name} only reads`, segment });
  }
  return out;
}

function isReadOnlyGit(head: Head): boolean {
  if (head.name !== 'git') return false;
  const sub = gitSubcommand(head.args);
  return sub !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(sub) && !head.args.some((a) => a.text === '-D' || a.text === '-d');
}

// ---------------------------------------------------------------- rule table

type Rule = (head: Head, ctx: ShellContext, segment: string) => ShellRiskMatch[];

const removeRule: Rule = (head, ctx, segment) => {
  const operands = head.args.filter((a) => !a.text.startsWith('-'));
  if (operands.length === 0) return [];
  const out: ShellRiskMatch[] = [];
  for (const operand of operands) {
    const verdict = pathVerdict(operand, ctx);
    if (verdict.kind === 'unresolvable') {
      out.push({
        rule: 'delete-unresolvable-target',
        risk: 'destructive',
        detail: `deletes '${operand.text}', whose expansion is not known before it runs`,
        segment,
      });
    } else if (verdict.kind === 'outside') {
      out.push({
        rule: 'delete-outside-workspace',
        risk: 'destructive',
        detail: `deletes '${operand.text}' (${verdict.resolved}), which is outside the workspace`,
        segment,
      });
    }
  }
  if (out.length === 0) {
    out.push({ rule: 'delete-inside-workspace', risk: 'write_reversible', detail: 'deletes files inside the workspace', segment });
  }
  return out;
};

const gitRule: Rule = (head, ctx, segment) => {
  const sub = gitSubcommand(head.args);
  const flags = head.args.filter((a) => a.text.startsWith('-')).map((a) => a.text);
  const operands = head.args.filter((a) => !a.text.startsWith('-')).map((a) => a.text);
  const protectedBranches = ctx.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
  const namesProtectedRef = (refs: readonly string[]): string | undefined =>
    refs.find((r) => {
      const leaf = r.split(':').pop() ?? r;
      const short = leaf.replace(/^\+/, '').replace(/^(refs\/heads\/|origin\/|upstream\/)/, '');
      return protectedBranches.includes(short);
    });

  switch (sub) {
    case 'push': {
      if (flags.some((f) => f === '--force' || f === '-f' || f === '--force-with-lease' || f.startsWith('--force-with-lease='))) {
        return [{ rule: 'git-force-push', risk: 'destructive', detail: 'force-pushes, rewriting history other clones already have', segment }];
      }
      if (flags.includes('--delete') || flags.includes('-d') || operands.some((o) => o.startsWith(':'))) {
        return [{ rule: 'git-delete-remote-branch', risk: 'destructive', detail: 'deletes a remote branch', segment }];
      }
      if (operands.some((o) => o.startsWith('+'))) {
        return [{ rule: 'git-force-push', risk: 'destructive', detail: 'uses a forcing (+) refspec', segment }];
      }
      return [{ rule: 'git-push', risk: 'external_side_effect', detail: 'publishes commits to a remote', segment }];
    }
    case 'reset': {
      if (!flags.includes('--hard')) return [];
      const ref = namesProtectedRef(operands.slice(1));
      if (ref) {
        return [{ rule: 'git-hard-reset-shared', risk: 'destructive', detail: `hard-resets onto shared ref '${ref}', discarding work others may depend on`, segment }];
      }
      return [{ rule: 'git-hard-reset', risk: 'write_reversible', detail: 'discards uncommitted changes in this worktree', segment }];
    }
    case 'branch': {
      if (!flags.includes('-D') && !flags.includes('-d') && !flags.includes('--delete')) return [];
      const ref = namesProtectedRef(operands.slice(1));
      return ref
        ? [{ rule: 'git-delete-protected-branch', risk: 'destructive', detail: `deletes protected branch '${ref}'`, segment }]
        : [{ rule: 'git-delete-branch', risk: 'write_reversible', detail: 'deletes a local branch', segment }];
    }
    case 'tag':
      return flags.includes('-d') || flags.includes('--delete')
        ? [{ rule: 'git-delete-tag', risk: 'destructive', detail: 'deletes a tag', segment }]
        : [];
    case 'clean':
      return [{ rule: 'git-clean', risk: 'write_reversible', detail: 'removes untracked files from the worktree', segment }];
    case 'filter-branch':
      return [{ rule: 'git-rewrite-history', risk: 'destructive', detail: 'rewrites repository history in place', segment }];
    default:
      return [];
  }
};

const ddRule: Rule = (head, _ctx, segment) =>
  head.args.some((a) => /^of=\/dev\//.test(a.text))
    ? [{ rule: 'raw-device-write', risk: 'destructive', detail: 'writes directly to a block device', segment }]
    : [];

const diskutilRule: Rule = (head, _ctx, segment) => {
  const sub = (firstOperand(head.args) ?? '').toLowerCase();
  return /^(erasedisk|erasevolume|partitiondisk|reformat|zerodisk|randomdisk|apfs)$/.test(sub)
    ? [{ rule: 'disk-format', risk: 'destructive', detail: `diskutil ${sub} destroys a volume`, segment }]
    : [];
};

const alwaysDestructive = (rule: string, detail: string): Rule => (_h, _c, segment) => [
  { rule, risk: 'destructive', detail, segment },
];

const httpRule: Rule = (head, _ctx, segment) => {
  const mutating = head.args.some((a, i) => {
    const t = a.text;
    if (/^(-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|-T|--upload-file)$/.test(t)) return true;
    if (t === '-X' || t === '--request') {
      const next = head.args[i + 1]?.text?.toUpperCase();
      return next !== undefined && next !== 'GET' && next !== 'HEAD';
    }
    return /^--request=(?!GET|HEAD)/i.test(t);
  });
  return mutating
    ? [{ rule: 'network-write', risk: 'external_side_effect', detail: 'sends a mutating HTTP request', segment }]
    : [{ rule: 'network-read', risk: 'read', detail: 'fetches a remote resource', segment }];
};

const ghRule: Rule = (head, _ctx, segment) => {
  const [a, b] = operandPair(head.args);
  const pair = `${a ?? ''} ${b ?? ''}`.trim();
  if (/^repo delete$/.test(pair) || /^secret (set|delete)$/.test(pair)) {
    return [{ rule: 'github-destructive', risk: 'destructive', detail: `\`gh ${pair}\` is not reversible from Tandemise`, segment }];
  }
  if (/^pr merge$/.test(pair) || /^release (create|edit|delete)$/.test(pair) || /^workflow run$/.test(pair)) {
    return [{ rule: 'github-release', risk: 'release', detail: `\`gh ${pair}\` publishes or merges`, segment }];
  }
  if (/^(pr|issue) (create|comment|edit|close|reopen)$/.test(pair)) {
    return [{ rule: 'github-write', risk: 'external_side_effect', detail: `\`gh ${pair}\` writes to GitHub`, segment }];
  }
  if (head.args.some((w) => w.text === '-X' || w.text === '--method')) {
    return [{ rule: 'github-api-write', risk: 'external_side_effect', detail: 'calls the GitHub API with an explicit method', segment }];
  }
  return [{ rule: 'github-read', risk: 'read', detail: 'reads from GitHub', segment }];
};

const packageManagerRule: Rule = (head, _ctx, segment) => {
  const sub = firstOperand(head.args);
  return sub === 'publish'
    ? [{ rule: 'package-publish', risk: 'release', detail: `${head.name} publish pushes a package to a public registry`, segment }]
    : [];
};

const kubectlRule: Rule = (head, _ctx, segment) => {
  const sub = firstOperand(head.args);
  if (sub === 'delete') return [{ rule: 'cluster-delete', risk: 'destructive', detail: 'deletes cluster resources', segment }];
  if (sub === 'apply' || sub === 'rollout' || sub === 'scale') {
    return [{ rule: 'cluster-apply', risk: 'release', detail: `kubectl ${sub} changes a live cluster`, segment }];
  }
  return [];
};

const terraformRule: Rule = (head, _ctx, segment) => {
  const sub = firstOperand(head.args);
  if (sub === 'destroy') return [{ rule: 'infra-destroy', risk: 'destructive', detail: 'destroys provisioned infrastructure', segment }];
  if (sub === 'apply') return [{ rule: 'infra-apply', risk: 'release', detail: 'applies infrastructure changes', segment }];
  return [];
};

const keychainRule: Rule = (head, _ctx, segment) => {
  const sub = firstOperand(head.args) ?? '';
  return /^(find-generic-password|find-internet-password|dump-keychain|export)$/.test(sub)
    ? [{ rule: 'credential-read', risk: 'destructive', detail: 'reads credentials out of the macOS keychain', segment }]
    : [];
};

/**
 * Commands whose operands are destinations, not just inputs. `credentialReads`
 * already catches reading a credential; these catch *overwriting* one, which is
 * how an agent would plant an SSH key rather than steal one.
 */
const writeTargetRule: Rule = (head, ctx, segment) => {
  const out: ShellRiskMatch[] = [];
  for (const arg of head.args) {
    if (arg.text.startsWith('-')) continue;
    if (!isSensitivePath(arg.text)) continue;
    const verdict = pathVerdict(arg, ctx);
    if (verdict.kind === 'inside') continue;
    out.push({
      rule: 'credential-write',
      risk: 'destructive',
      detail: `writes to credential material at '${arg.text}'`,
      segment,
    });
  }
  return out;
};

/** Matches a path that holds credentials or machine-wide configuration. */
function isSensitivePath(raw: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(raw))
    || CONTEXTUAL_CREDENTIAL_PATTERNS.some((re) => re.test(raw));
}

const RULES: Readonly<Record<string, Rule>> = {
  tee: writeTargetRule,
  mv: writeTargetRule,
  cp: writeTargetRule,
  install: writeTargetRule,
  chmod: writeTargetRule,
  chown: writeTargetRule,
  ...Object.fromEntries([...REMOVERS].map((name) => [name, removeRule])),
  git: gitRule,
  dd: ddRule,
  diskutil: diskutilRule,
  mkfs: alwaysDestructive('disk-format', 'formats a filesystem'),
  'mkfs.ext4': alwaysDestructive('disk-format', 'formats a filesystem'),
  newfs: alwaysDestructive('disk-format', 'formats a filesystem'),
  fdisk: alwaysDestructive('disk-partition', 'rewrites a partition table'),
  parted: alwaysDestructive('disk-partition', 'rewrites a partition table'),
  wipefs: alwaysDestructive('disk-wipe', 'erases filesystem signatures'),
  curl: httpRule, wget: httpRule,
  gh: ghRule,
  npm: packageManagerRule, pnpm: packageManagerRule, yarn: packageManagerRule,
  kubectl: kubectlRule,
  terraform: terraformRule,
  security: keychainRule,
};

// ------------------------------------------------------------- credentials

/**
 * Output redirection.
 *
 * A redirection target is written by the *shell*, not by the command, so no
 * per-command rule can see it: `echo x > ~/.ssh/authorized_keys` is, as far as
 * the rule table is concerned, a harmless `echo`. The words are scanned
 * separately for `>`/`>>` and their destinations treated as writes.
 */
function redirectionWrites(words: readonly Word[], ctx: ShellContext, segment: string): ShellRiskMatch[] {
  const out: ShellRiskMatch[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.quoted) continue;
    const match = /^\d*>>?(.*)$/.exec(word.text);
    if (!match) continue;
    // `> path` (target in the next word) or `>path` (target attached).
    const targetText = match[1] !== '' ? match[1]! : words[i + 1]?.text;
    if (!targetText || targetText.startsWith('-')) continue;
    if (!isSensitivePath(targetText)) continue;
    const verdict = pathVerdict({ text: targetText, quoted: false }, ctx);
    if (verdict.kind === 'inside') continue;
    out.push({
      rule: 'credential-write',
      risk: 'destructive',
      detail: `redirects output onto credential material at '${targetText}'`,
      segment,
    });
  }
  return out;
}

function credentialReads(head: Head, ctx: ShellContext, segment: string): ShellRiskMatch[] {
  const out: ShellRiskMatch[] = [];
  for (const arg of head.args) {
    if (arg.text.startsWith('-')) continue;
    const raw = arg.text;
    if (CREDENTIAL_PATTERNS.some((re) => re.test(raw))) {
      out.push({ rule: 'credential-read', risk: 'destructive', detail: `reads credential material at '${raw}'`, segment });
      continue;
    }
    if (CONTEXTUAL_CREDENTIAL_PATTERNS.some((re) => re.test(raw))) {
      const verdict = pathVerdict(arg, ctx);
      if (verdict.kind !== 'inside') {
        out.push({ rule: 'credential-read', risk: 'destructive', detail: `reads '${raw}' from outside the workspace`, segment });
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------- paths

type PathVerdict =
  | { kind: 'inside'; resolved: string }
  | { kind: 'outside'; resolved: string }
  | { kind: 'unresolvable' };

/**
 * Anything containing an unexpanded variable, command substitution, or a glob
 * that can escape the workspace is `unresolvable` and fails closed. We cannot
 * know what `rm -rf "$BUILD_DIR"` deletes, so we must not claim it is safe.
 */
function pathVerdict(word: Word, ctx: ShellContext): PathVerdict {
  const raw = word.text;
  if (/[$`]/.test(raw)) return { kind: 'unresolvable' };
  // A glob is fine as long as its fixed prefix is already inside the workspace.
  const fixedPrefix = raw.split(/[*?[]/)[0] ?? raw;
  const candidate = fixedPrefix === '' ? raw : fixedPrefix;
  if (candidate === '/' || candidate === '') return { kind: 'outside', resolved: '/' };
  const resolved = absolutePath(candidate, ctx.cwd);
  const inside = ctx.writableRoots.some((root) => isPathInside(absolutePath(root, ctx.cwd), resolved));
  return inside ? { kind: 'inside', resolved } : { kind: 'outside', resolved };
}

// ------------------------------------------------------------------ lexing

function firstOperand(args: readonly Word[]): string | undefined {
  return args.find((a) => !a.text.startsWith('-'))?.text;
}

function operandPair(args: readonly Word[]): readonly [string | undefined, string | undefined] {
  const operands = args.filter((a) => !a.text.startsWith('-')).map((a) => a.text);
  return [operands[0], operands[1]];
}

function basename(command: string): string {
  const slash = command.lastIndexOf('/');
  return slash === -1 ? command : command.slice(slash + 1);
}

/**
 * Quote-aware split into pipelines and then into piped commands.
 *
 * This is not a shell parser and does not try to be one - it only needs to be
 * right about where one command ends and the next begins, because every segment
 * is classified and the worst risk wins. Getting a separator wrong is the
 * expensive failure: an unrecognised one turns the following command into
 * harmless-looking *arguments* of the preceding one, which is how
 * `sleep 1 & rm -rf ~` used to classify as a `sleep`.
 *
 * Handled: `;` `\n` `&&` `||` `|` and a bare `&`, plus subshell `( )`, group
 * `{ }`, command substitution `$( )` and backticks, all of which introduce a
 * fresh command position.
 */
function splitPipelines(command: string): Pipeline[] {
  const pipelines: Pipeline[] = [];
  let currentCommands: Word[][] = [];
  let currentWords: Word[] = [];
  let current = '';
  let quoted = false;
  let raw = '';
  let quote: '"' | "'" | null = null;

  const endWord = (): void => {
    if (current !== '') { currentWords.push({ text: current, quoted }); current = ''; quoted = false; }
  };
  const endCommand = (): void => { endWord(); if (currentWords.length) { currentCommands.push(currentWords); currentWords = []; } };
  const endPipeline = (): void => {
    endCommand();
    if (currentCommands.length) pipelines.push({ raw: raw.trim(), commands: currentCommands });
    currentCommands = [];
    raw = '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    raw += ch;
    if (quote) {
      if (ch === quote) { quote = null; quoted = true; } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; continue; }
    if (ch === '\\' && i + 1 < command.length) { current += command[i + 1]!; raw += command[i + 1]!; i++; continue; }
    if (ch === '\n' || ch === ';') { raw = raw.slice(0, -1); endPipeline(); continue; }
    if (ch === '&' && command[i + 1] === '&') { raw = raw.slice(0, -1); endPipeline(); i++; continue; }
    if (ch === '|' && command[i + 1] === '|') { raw = raw.slice(0, -1); endPipeline(); i++; continue; }
    if (ch === '|') { endCommand(); continue; }
    // A bare `&` backgrounds the command and starts a new one. Missing this was
    // a real bypass, not a nicety.
    if (ch === '&') { raw = raw.slice(0, -1); endPipeline(); continue; }
    // `$(`, backtick, `(` and `{` all open a fresh command position; their
    // closers end it. Treating them as separators means the inner command is
    // classified on its own rather than absorbed as an argument.
    if (ch === '$' && command[i + 1] === '(') { raw = raw.slice(0, -1); endPipeline(); i++; continue; }
    if (ch === '`' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      raw = raw.slice(0, -1);
      endPipeline();
      continue;
    }
    if (/\s/.test(ch)) { endWord(); continue; }
    current += ch;
  }
  endPipeline();
  return pipelines;
}
