// Collects per-scenario proof: checks with their observed values, and screenshots.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../evidence/', import.meta.url).pathname;

export class Evidence {
  constructor(id, title) {
    this.id = id; this.title = title; this.checks = []; this.notes = []; this.shots = [];
    mkdirSync(ROOT, { recursive: true });
  }
  note(text) { this.notes.push(text); console.log(`  · ${text}`); }
  check(label, cond, observed) {
    this.checks.push({ label, ok: Boolean(cond), observed });
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${observed === undefined ? '' : `  → ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`}`);
    return Boolean(cond);
  }
  shot(name) { const f = join(ROOT, `${this.id}-${name}.png`); this.shots.push(f); return f; }
  get ok() { return this.checks.length > 0 && this.checks.every((c) => c.ok); }
  save() {
    writeFileSync(join(ROOT, `${this.id}.json`), JSON.stringify({ id: this.id, title: this.title, ok: this.ok, checks: this.checks, notes: this.notes, shots: this.shots }, null, 2));
    console.log(`${this.id}: ${this.ok ? 'PASS' : 'FAIL'} (${this.checks.filter((c) => c.ok).length}/${this.checks.length})`);
  }
}
