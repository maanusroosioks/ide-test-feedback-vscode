import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dotnetTestAdapter } from '../../../src/adapters/dotnet-test';
import { gradleJunitAdapter } from '../../../src/adapters/gradle-junit';
import { mavenJunitAdapter } from '../../../src/adapters/maven-junit';
import { pytestAdapter } from '../../../src/adapters/pytest';
import { pathExists, runCommand, type RunCommandOptions } from '../../../src/util/shell';

// The real build tools aren't installed in CI; each test plays the tool by writing the report
// where the real one would.
vi.mock('../../../src/util/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/util/shell')>()),
  runCommand: vi.fn(),
}));

const FIXTURES_DIR = join(__dirname, '../fixtures');

const JUNIT_XML = `<?xml version="1.0"?>
<testsuite name="com.example.CalculatorTest">
  <testcase classname="com.example.CalculatorTest" name="adds" time="0.01"/>
  <testcase classname="com.example.CalculatorTest" name="divides" time="0.02">
    <failure message="expected 2">stack</failure>
  </testcase>
</testsuite>`;

type ToolBehavior = (command: string, options: RunCommandOptions) => Promise<void> | void;

function simulateTool(behavior: ToolBehavior = () => {}): void {
  vi.mocked(runCommand).mockImplementation(async (command, options) => {
    await behavior(command, options);
    return { exitCode: 0, stdout: 'tool output', stderr: '' };
  });
}

function lastCommand(): { command: string; options: RunCommandOptions } {
  const [command, options] = vi.mocked(runCommand).mock.lastCall!;
  return { command, options };
}

async function writeReport(dir: string, name: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), content, 'utf8');
}

let folder: string;

beforeEach(async () => {
  vi.mocked(runCommand).mockReset();
  folder = await mkdtemp(join(tmpdir(), 'moodle-adapter-'));
});

describe('mavenJunitAdapter', () => {
  it('detects a folder with a pom.xml', async () => {
    expect(await mavenJunitAdapter.detect(folder)).toBe(false);
    await writeFile(join(folder, 'pom.xml'), '<project/>', 'utf8');
    expect(await mavenJunitAdapter.detect(folder)).toBe(true);
  });

  it('runs mvn in batch mode from the project folder', async () => {
    simulateTool();

    await mavenJunitAdapter.run(folder, {});

    expect(lastCommand().command).toBe('mvn -B test');
    expect(lastCommand().options.cwd).toBe(folder);
  });

  it('uses a command override verbatim', async () => {
    simulateTool();

    await mavenJunitAdapter.run(folder, { commandOverride: 'mvn -Pci test' });

    expect(lastCommand().command).toBe('mvn -Pci test');
  });

  it('collects surefire reports from every module of a reactor build', async () => {
    simulateTool(async () => {
      await writeReport(join(folder, 'core/target/surefire-reports'), 'TEST-a.xml', JUNIT_XML);
      await writeReport(join(folder, 'app/target/surefire-reports'), 'TEST-b.xml', JUNIT_XML);
    });

    const result = await mavenJunitAdapter.run(folder, {});

    expect(result.run).toMatchObject({ adapterId: 'maven-junit', language: 'java' });
    expect(result.run.results).toHaveLength(4);
    expect(result.run.results.map((r) => r.status)).toEqual(['PASSED', 'FAILED', 'PASSED', 'FAILED']);
    expect(result.reportError).toBeUndefined();
  });

  it('clears reports left by an earlier run before starting, so a skipped module cannot resurface', async () => {
    const stale = join(folder, 'old-module/target/surefire-reports');
    await writeReport(stale, 'TEST-stale.xml', JUNIT_XML);
    let staleSeenByTool = true;
    simulateTool(async () => {
      staleSeenByTool = await pathExists(stale);
    });

    const result = await mavenJunitAdapter.run(folder, {});

    expect(staleSeenByTool).toBe(false);
    expect(result.run.results).toEqual([]);
  });

  it('logs unreadable report files and keeps the readable ones', async () => {
    const logged: string[] = [];
    simulateTool(async () => {
      const dir = join(folder, 'target/surefire-reports');
      await writeReport(dir, 'TEST-good.xml', JUNIT_XML);
      await writeReport(dir, 'TEST-broken.xml', 'not xml at all');
    });

    const result = await mavenJunitAdapter.run(folder, { logger: { log: (m) => logged.push(m) } });

    expect(result.run.results).toHaveLength(2);
    expect(logged.join('\n')).toContain('TEST-broken.xml');
  });
});

describe('gradleJunitAdapter', () => {
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const wrapperInvocation = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

  it.each(['build.gradle', 'build.gradle.kts'])('detects a folder with %s', async (buildFile) => {
    expect(await gradleJunitAdapter.detect(folder)).toBe(false);
    await writeFile(join(folder, buildFile), '', 'utf8');
    expect(await gradleJunitAdapter.detect(folder)).toBe(true);
  });

  it('prefers the project wrapper when there is one', async () => {
    await writeFile(join(folder, wrapper), '', 'utf8');
    simulateTool();

    await gradleJunitAdapter.run(folder, {});

    expect(lastCommand().command).toBe(`${wrapperInvocation} cleanTest test`);
  });

  it('falls back to gradle on PATH without a wrapper', async () => {
    simulateTool();

    await gradleJunitAdapter.run(folder, {});

    expect(lastCommand().command).toBe('gradle cleanTest test');
  });

  it('clears stale results even when an override omits cleanTest', async () => {
    const stale = join(folder, 'build/test-results/test');
    await writeReport(stale, 'TEST-stale.xml', JUNIT_XML);
    let staleSeenByTool = true;
    simulateTool(async () => {
      staleSeenByTool = await pathExists(stale);
    });

    await gradleJunitAdapter.run(folder, { commandOverride: 'gradle test --offline' });

    expect(lastCommand().command).toBe('gradle test --offline');
    expect(staleSeenByTool).toBe(false);
  });

  it('collects results from each subproject of a multi-project build', async () => {
    simulateTool(async () => {
      await writeReport(join(folder, 'lib/build/test-results/test'), 'TEST-lib.xml', JUNIT_XML);
      await writeReport(join(folder, 'app/build/test-results/test'), 'TEST-app.xml', JUNIT_XML);
      // Other test tasks are not what `test` ran.
      await writeReport(join(folder, 'app/build/test-results/integrationTest'), 'TEST-it.xml', JUNIT_XML);
    });

    const result = await gradleJunitAdapter.run(folder, {});

    expect(result.run).toMatchObject({ adapterId: 'gradle-junit', language: 'java' });
    expect(result.run.results).toHaveLength(4);
  });
});

describe('pytestAdapter', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';

  function reportPathOf(command: string): string {
    const match = /--junit-xml="([^"]+)"/.exec(command);
    if (!match) throw new Error(`no --junit-xml flag in: ${command}`);
    return match[1];
  }

  it.each(['pytest.ini', 'pyproject.toml', 'setup.cfg', 'conftest.py'])(
    'detects a folder with %s',
    async (marker) => {
      expect(await pytestAdapter.detect(folder)).toBe(false);
      await writeFile(join(folder, marker), '', 'utf8');
      expect(await pytestAdapter.detect(folder)).toBe(true);
    },
  );

  it('runs pytest as a module and asks for a JUnit XML report in the temp directory', async () => {
    simulateTool();

    await pytestAdapter.run(folder, {});

    const { command } = lastCommand();
    expect(command.startsWith(`${python} -m pytest --junit-xml="`)).toBe(true);
    expect(reportPathOf(command).startsWith(tmpdir())).toBe(true);
  });

  it('appends the report flag to a command override', async () => {
    simulateTool();

    await pytestAdapter.run(folder, { commandOverride: 'poetry run pytest -q' });

    expect(lastCommand().command).toMatch(/^poetry run pytest -q --junit-xml=".+\.xml"$/);
  });

  it('parses the report pytest wrote and removes it on cleanup', async () => {
    const fixture = await readFile(join(FIXTURES_DIR, 'junit/sample-pytest-junit.xml'), 'utf8');
    let reportPath = '';
    simulateTool(async (command) => {
      reportPath = reportPathOf(command);
      await writeFile(reportPath, fixture, 'utf8');
    });

    const result = await pytestAdapter.run(folder, {});

    expect(result.run).toMatchObject({ adapterId: 'pytest', language: 'python' });
    expect(result.run.results).toHaveLength(4);
    expect(await pathExists(reportPath)).toBe(true);

    await result.cleanup();
    expect(await pathExists(reportPath)).toBe(false);
  });

  it('explains a missing report rather than reporting zero tests', async () => {
    simulateTool();

    const result = await pytestAdapter.run(folder, {});

    expect(result.run.results).toEqual([]);
    expect(result.reportError).toContain('no report was written');
  });

  it('gives each run its own report file', async () => {
    simulateTool();

    await pytestAdapter.run(folder, {});
    const first = reportPathOf(lastCommand().command);
    await pytestAdapter.run(folder, {});
    const second = reportPathOf(lastCommand().command);

    expect(first).not.toBe(second);
  });
});

describe('dotnetTestAdapter', () => {
  function trxPathOf(command: string): string {
    const name = /--logger "trx;LogFileName=([^"]+)"/.exec(command)?.[1];
    const dir = /--results-directory "([^"]+)"/.exec(command)?.[1];
    if (!name || !dir) throw new Error(`no TRX logger flags in: ${command}`);
    return join(dir, name);
  }

  it.each(['App.csproj', 'App.sln'])('detects a folder with %s', async (projectFile) => {
    expect(await dotnetTestAdapter.detect(folder)).toBe(false);
    await writeFile(join(folder, projectFile), '', 'utf8');
    expect(await dotnetTestAdapter.detect(folder)).toBe(true);
  });

  it('does not detect a folder that cannot be read', async () => {
    expect(await dotnetTestAdapter.detect(join(folder, 'missing'))).toBe(false);
  });

  it('asks dotnet test for a TRX report in the temp directory', async () => {
    simulateTool();

    await dotnetTestAdapter.run(folder, {});

    const { command } = lastCommand();
    expect(command.startsWith('dotnet test --logger "trx;LogFileName=')).toBe(true);
    expect(trxPathOf(command).startsWith(tmpdir())).toBe(true);
    expect(trxPathOf(command).endsWith('.trx')).toBe(true);
  });

  it('appends the report flags to a command override', async () => {
    simulateTool();

    await dotnetTestAdapter.run(folder, { commandOverride: 'dotnet test Calc.Tests' });

    expect(lastCommand().command.startsWith('dotnet test Calc.Tests --logger "trx;')).toBe(true);
  });

  it('parses the TRX report and removes it on cleanup', async () => {
    const fixture = await readFile(join(FIXTURES_DIR, 'dotnet/sample-results.trx'), 'utf8');
    let reportPath = '';
    simulateTool(async (command) => {
      reportPath = trxPathOf(command);
      await writeFile(reportPath, fixture, 'utf8');
    });

    const result = await dotnetTestAdapter.run(folder, {});

    expect(result.run).toMatchObject({ adapterId: 'dotnet-test', language: 'csharp' });
    expect(result.run.results.map((r) => r.status)).toEqual(['PASSED', 'FAILED', 'SKIPPED']);

    await result.cleanup();
    expect(await pathExists(reportPath)).toBe(false);
  });
});
