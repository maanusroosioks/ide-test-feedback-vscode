import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES_DIR = join(__dirname, '../fixtures');

/** `relative` is from test/unit/fixtures, e.g. `junit/sample-surefire-report.xml`. */
export function fixturePath(relative: string): string {
  return join(FIXTURES_DIR, relative);
}

export function readFixture(relative: string): string {
  return readFileSync(fixturePath(relative), 'utf8');
}

interface PackageJson {
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string }>;
    configuration: Array<{ properties: Record<string, { enum?: string[]; default?: unknown }> }>;
  };
}

/** The extension manifest, for checking the code against what it declares. */
export const packageJson: PackageJson = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));
