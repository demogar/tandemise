import { TandemiseError } from '@tandemise/shared';

/**
 * Minimum shape every pluggable provider descriptor shares. Concrete registries
 * (runtime adapters, execution targets, integration tools, app drivers) narrow
 * this with their own fields.
 */
export interface Descriptor {
  readonly id: string;
  readonly displayName: string;
  /** Free-form capability tags used for capability-based routing (MVP.md §P7). */
  readonly provides?: readonly string[];
}

/**
 * An id-keyed, capability-queryable collection of provider descriptors.
 *
 * Core services depend on a `Registry<T>`, never on a concrete provider. Routing
 * decisions ("which runtime can satisfy `shell` + `git`?") are answered against
 * the registry, so a newly contributed provider participates in routing the
 * moment it is registered - with no change to the scheduler.
 */
export class Registry<D extends Descriptor> {
  readonly #items = new Map<string, D>();

  constructor(readonly kind: string, items: readonly D[] = []) {
    for (const item of items) this.register(item);
  }

  register(item: D): this {
    if (this.#items.has(item.id)) {
      throw TandemiseError.validation(`Duplicate ${this.kind} provider id '${item.id}'`);
    }
    this.#items.set(item.id, item);
    return this;
  }

  get(id: string): D | undefined {
    return this.#items.get(id);
  }

  require(id: string): D {
    const found = this.#items.get(id);
    if (!found) {
      throw TandemiseError.notFound(
        `${this.kind} provider`,
        `${id} (available: ${[...this.#items.keys()].join(', ') || 'none'})`,
      );
    }
    return found;
  }

  has(id: string): boolean {
    return this.#items.has(id);
  }

  all(): readonly D[] {
    return [...this.#items.values()];
  }

  ids(): readonly string[] {
    return [...this.#items.keys()];
  }

  /** All providers advertising every one of the requested capability tags. */
  providing(...capabilities: readonly string[]): readonly D[] {
    return this.all().filter((d) => capabilities.every((c) => d.provides?.includes(c)));
  }

  filter(predicate: (d: D) => boolean): readonly D[] {
    return this.all().filter(predicate);
  }
}
