import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_ADAPTERS } from '../../../src/adapters';

const packageJson = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));

describe('ALL_ADAPTERS', () => {
  it('gives every adapter its own id', () => {
    const ids = ALL_ADAPTERS.map((adapter) => adapter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the preferredAdapter setting offered in package.json', () => {
    const setting = packageJson.contributes.configuration.properties['moodleSubmit.preferredAdapter'];
    expect(setting.enum).toEqual(ALL_ADAPTERS.map((adapter) => adapter.id));
  });
});
