import { TandemiseError } from '@tandemise/shared';
import { isMultiToken, type MultiToken, type Token } from './token.js';

export type Lifetime = 'singleton' | 'transient';

/**
 * Resolution context handed to factories. A factory receives the container
 * itself, so dependencies are pulled by token rather than pushed positionally -
 * this keeps registration order irrelevant and makes lazy/cyclic-free wiring
 * explicit.
 */
export interface Resolver {
  resolve<T>(t: Token<T>): T;
  resolveAll<T>(t: MultiToken<T>): readonly T[];
  tryResolve<T>(t: Token<T>): T | undefined;
  has(t: Token<unknown>): boolean;
}

export type Factory<T> = (r: Resolver) => T;

interface Binding<T> {
  factory: Factory<T>;
  lifetime: Lifetime;
  /** Called on container disposal, in reverse instantiation order. */
  dispose?: (instance: T) => void | Promise<void>;
  source: string;
}

export interface BindOptions<T> {
  lifetime?: Lifetime;
  dispose?: (instance: T) => void | Promise<void>;
  /** Human-readable origin, surfaced in diagnostics and cycle errors. */
  source?: string;
}

/**
 * A small, explicit inversion-of-control container.
 *
 * Deliberately *not* a decorator/reflection framework: bindings are plain
 * factories registered by the composition root, which keeps the wiring
 * greppable, keeps `emitDecoratorMetadata` out of the build, and means a new
 * provider is one `bind()` call rather than a class-hierarchy change.
 *
 * Guarantees:
 *  - singletons are instantiated at most once, even under re-entrant resolution;
 *  - dependency cycles fail loudly with the full resolution path;
 *  - disposal runs in reverse instantiation order so a supervisor shuts down
 *    before the database it writes to.
 */
export class Container implements Resolver {
  readonly #bindings = new Map<Token<unknown>, Binding<unknown>>();
  readonly #multi = new Map<Token<unknown>, Array<Binding<unknown>>>();
  readonly #singletons = new Map<Token<unknown>, unknown>();
  readonly #disposables: Array<() => void | Promise<void>> = [];
  readonly #resolving: Array<Token<unknown>> = [];
  readonly #parent: Container | undefined;
  #disposed = false;

  constructor(parent?: Container) {
    this.#parent = parent;
  }

  bind<T>(t: Token<T>, factory: Factory<T>, options: BindOptions<T> = {}): this {
    if (isMultiToken(t)) {
      throw TandemiseError.validation(
        `Use contribute() for multi-token ${t.description}`,
      );
    }
    if (this.#bindings.has(t)) {
      throw TandemiseError.validation(
        `Token ${t.description} is already bound (by ${this.#bindings.get(t)!.source}). ` +
          `Use rebind() if replacement is intentional.`,
      );
    }
    this.#bindings.set(t as Token<unknown>, {
      factory: factory as Factory<unknown>,
      lifetime: options.lifetime ?? 'singleton',
      dispose: options.dispose as Binding<unknown>['dispose'],
      source: options.source ?? 'unknown',
    });
    return this;
  }

  /** Replaces an existing binding. Intended for tests and explicit overrides. */
  rebind<T>(t: Token<T>, factory: Factory<T>, options: BindOptions<T> = {}): this {
    this.#bindings.delete(t as Token<unknown>);
    this.#singletons.delete(t as Token<unknown>);
    return this.bind(t, factory, options);
  }

  bindValue<T>(t: Token<T>, value: T, options: BindOptions<T> = {}): this {
    return this.bind(t, () => value, { ...options, lifetime: 'singleton' });
  }

  /**
   * Adds one contribution to a multi-token. This is the plugin seam: every
   * runtime adapter, execution target factory, and integration tool provider
   * contributes to a collection the core resolves without naming any member.
   */
  contribute<T>(t: MultiToken<T>, factory: Factory<T>, options: BindOptions<T> = {}): this {
    const list = this.#multi.get(t as Token<unknown>) ?? [];
    list.push({
      factory: factory as Factory<unknown>,
      lifetime: options.lifetime ?? 'singleton',
      dispose: options.dispose as Binding<unknown>['dispose'],
      source: options.source ?? 'unknown',
    });
    this.#multi.set(t as Token<unknown>, list);
    return this;
  }

  has(t: Token<unknown>): boolean {
    return this.#bindings.has(t) || this.#multi.has(t) || (this.#parent?.has(t) ?? false);
  }

  tryResolve<T>(t: Token<T>): T | undefined {
    return this.has(t) ? this.resolve(t) : undefined;
  }

  resolve<T>(t: Token<T>): T {
    this.#assertUsable();
    if (isMultiToken(t)) return this.resolveAll(t as MultiToken<unknown>) as T;

    if (this.#singletons.has(t as Token<unknown>)) {
      return this.#singletons.get(t as Token<unknown>) as T;
    }
    const binding = this.#bindings.get(t as Token<unknown>);
    if (!binding) {
      if (this.#parent) return this.#parent.resolve(t);
      throw new TandemiseError('INTERNAL', `No binding registered for ${t.description}`, {
        details: { token: t.description, known: this.#describeBindings() },
      });
    }
    return this.#instantiate(t as Token<unknown>, binding) as T;
  }

  resolveAll<T>(t: MultiToken<T>): readonly T[] {
    this.#assertUsable();
    const inherited = this.#parent ? this.#parent.resolveAll(t) : [];
    const cached = this.#singletons.get(t as Token<unknown>) as T[] | undefined;
    if (cached) return [...inherited, ...cached];

    const list = this.#multi.get(t as Token<unknown>) ?? [];
    const instances = list.map((b) => this.#instantiateContribution(t, b) as T);
    this.#singletons.set(t as Token<unknown>, instances);
    return [...inherited, ...instances];
  }

  /** Child container for run-scoped bindings (e.g. per-run tool gateways). */
  createScope(): Container {
    return new Container(this);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const d of [...this.#disposables].reverse()) {
      try { await d(); } catch { /* disposal must not mask the original failure */ }
    }
    this.#disposables.length = 0;
    this.#singletons.clear();
  }

  /** Diagnostics for the Settings → developer surface. */
  describe(): Array<{ token: string; lifetime: Lifetime; source: string; instantiated: boolean }> {
    const rows: Array<{ token: string; lifetime: Lifetime; source: string; instantiated: boolean }> = [];
    for (const [t, b] of this.#bindings) {
      rows.push({ token: t.description, lifetime: b.lifetime, source: b.source, instantiated: this.#singletons.has(t) });
    }
    for (const [t, list] of this.#multi) {
      for (const b of list) {
        rows.push({ token: t.description, lifetime: b.lifetime, source: b.source, instantiated: this.#singletons.has(t) });
      }
    }
    return rows.sort((a, b) => a.token.localeCompare(b.token));
  }

  #instantiate(t: Token<unknown>, binding: Binding<unknown>): unknown {
    this.#enter(t);
    try {
      const instance = binding.factory(this);
      if (binding.lifetime === 'singleton') {
        this.#singletons.set(t, instance);
        if (binding.dispose) this.#disposables.push(() => binding.dispose!(instance));
      }
      return instance;
    } finally {
      this.#resolving.pop();
    }
  }

  #instantiateContribution(t: Token<unknown>, binding: Binding<unknown>): unknown {
    this.#enter(t);
    try {
      const instance = binding.factory(this);
      if (binding.dispose) this.#disposables.push(() => binding.dispose!(instance));
      return instance;
    } finally {
      this.#resolving.pop();
    }
  }

  #enter(t: Token<unknown>): void {
    if (this.#resolving.includes(t)) {
      const path = [...this.#resolving, t].map((x) => x.description).join(' → ');
      throw new TandemiseError('INTERNAL', `Dependency cycle detected: ${path}`, {
        details: { path },
      });
    }
    this.#resolving.push(t);
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new TandemiseError('INTERNAL', 'Container has been disposed');
    }
  }

  #describeBindings(): string[] {
    return [...this.#bindings.keys(), ...this.#multi.keys()].map((t) => t.description).sort();
  }
}
