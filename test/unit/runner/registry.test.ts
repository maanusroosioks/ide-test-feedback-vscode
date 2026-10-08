import { describe, expect, it } from 'vitest';
import { NoAdapterFoundError } from '../../../src/runner/registry';
import type { TestRunnerAdapter } from '../../../src/runner/types';
import { registryWith, stubAdapter } from '../helpers/fakes';

function adapter(id: string, matches: boolean): TestRunnerAdapter {
  return stubAdapter(id, { detect: async () => matches });
}

describe('AdapterRegistry', () => {
  it('auto-picks the single matching adapter', async () => {
    const registry = registryWith(adapter('a', false), adapter('b', true));

    const resolved = await registry.resolveAdapter('/some/folder');
    expect(resolved.id).toBe('b');
  });

  it('throws NoAdapterFoundError when nothing matches', async () => {
    const registry = registryWith(adapter('a', false));

    await expect(registry.resolveAdapter('/some/folder')).rejects.toBeInstanceOf(NoAdapterFoundError);
  });

  it('delegates to pickFromMultiple when several adapters match', async () => {
    const registry = registryWith(adapter('a', true), adapter('b', true));

    const resolved = await registry.resolveAdapter('/some/folder', {
      pickFromMultiple: async (candidates) => candidates[1],
    });
    expect(resolved.id).toBe('b');
  });

  it('honors preferredAdapterId, bypassing detection entirely', async () => {
    const registry = registryWith(adapter('a', false), adapter('b', false));

    const resolved = await registry.resolveAdapter('/some/folder', { preferredAdapterId: 'a' });
    expect(resolved.id).toBe('a');
  });

  it('throws NoAdapterFoundError for an unregistered preferredAdapterId', async () => {
    const registry = registryWith(adapter('a', true));

    await expect(
      registry.resolveAdapter('/some/folder', { preferredAdapterId: 'nonexistent' }),
    ).rejects.toBeInstanceOf(NoAdapterFoundError);
  });
});
