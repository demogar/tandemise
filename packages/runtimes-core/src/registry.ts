import { Registry, token } from '@tandemise/kernel';
import type { AgentRuntimeAdapter, RuntimeAdapterDescriptor } from './adapter.js';
import { describeAdapter } from './adapter.js';

/**
 * The id-keyed view of every contributed runtime adapter.
 *
 * Routing asks this registry "who provides `shell` and `git`?" and never names
 * an adapter, which is what makes a new runtime a purely additive change
 * (MVP.md §P7).
 */
export class RuntimeRegistry extends Registry<RuntimeAdapterDescriptor> {
  constructor(adapters: readonly AgentRuntimeAdapter[] = []) {
    super('runtime adapter', adapters.map(describeAdapter));
  }

  adapter(id: string): AgentRuntimeAdapter {
    return this.require(id).adapter;
  }

  tryAdapter(id: string): AgentRuntimeAdapter | undefined {
    return this.get(id)?.adapter;
  }

  adapters(): readonly AgentRuntimeAdapter[] {
    return this.all().map((d) => d.adapter);
  }
}

export const RUNTIME_REGISTRY = token<RuntimeRegistry>('RuntimeRegistry');
