import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dotnetTestAdapter } from '../../../src/ecosystems/dotnet/dotnet-test';
import { gradleJunitAdapter } from '../../../src/ecosystems/jvm/gradle-junit';
import { mavenJunitAdapter } from '../../../src/ecosystems/jvm/maven-junit';
import { pytestAdapter } from '../../../src/ecosystems/python/pytest';
import { pathExists, runCommand, type RunCommandOptions } from '../../../src/util/shell';
import { recordingLogger } from '../helpers/fakes';
import { tempDir, writeTree } from '../helpers/fs';
import { readFixture } from '../helpers/project';

// The real build tools needn't be installed: each test plays the tool by writing the report
// where the real one would.
vi.mock('../../../src/util/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/util/shell')>()),
  runCommand: vi.fn(),
}));

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

let folder: string;

beforeEach(async () => {
  vi.mocked(runCommand).mockReset();
  folder = await tempDir();
});

describe('mavenJunitAdapter', () => {
  it('detects a folder with a pom.xml', async () => {
    expect(await mavenJunitAdapter.detect(folder)).toBe(false);
    await writeTree(folder, { 'pom.xml': '<project/>' });
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
    simulateTool(() =>
      writeTree(folder, {
        'core/target/surefire-reports/TEST-a.xml': JUNIT_XML,
        'app/target/surefire-reports/TEST-b.xml': JUNIT_XML,
      }),
    );

    const result = await mavenJunitAdapter.run(folder, {});

    expect(result.run).toMatchObject({ adapterId: 'maven-junit', platform: 'jvm' });
    expect(result.run.results).toHaveLength(4);
    expect(result.run.results.map((r) => r.status)).toEqual(['PASSED', 'FAILED', 'PASSED', 'FAILED']);
    expect(result.reportError).toBeUndefined();
  });

  it('clears reports left by an earlier run before starting, so a skipped module cannot resurface', async () => {
    const stale = join(folder, 'old-module/target/surefire-reports');
    await writeTree(stale, { 'TEST-stale.xml': JUNIT_XML });
    let staleSeenByTool = true;
    simulateTool(async () => {
      staleSeenByTool = await pathExists(stale);
    });

    const result = await mavenJunitAdapter.run(folder, {});

    expect(staleSeenByTool).toBe(false);
    expect(result.run.results).toEqual([]);
  });

  it('logs unreadable report files and keeps the readable ones', async () => {
    const logger = recordingLogger();
    simulateTool(() =>
      writeTree(folder, {
        'target/surefire-reports/TEST-good.xml': JUNIT_XML,
        'target/surefire-reports/TEST-broken.xml': 'not xml at all',
      }),
    );

    const result = await mavenJunitAdapter.run(folder, { logger });

    expect(result.run.results).toHaveLength(2);
    expect(logger.messages).toContainEqual(expect.stringContaining('TEST-broken.xml'));
  });
});

describe('gradleJunitAdapter', () => {
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const wrapperInvocation = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

  it.each(['build.gradle', 'build.gradle.kts'])('detects a folder with %s', async (buildFile) => {
    expect(await gradleJunitAdapter.detect(folder)).toBe(false);
    await writeTree(folder, { [buildFile]: '' });
    expect(await gradleJunitAdapter.detect(folder)).toBe(true);
  });

  it('prefers the project wrapper when there is one', async () => {
    await writeTree(folder, { [wrapper]: '' });
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
    await writeTree(stale, { 'TEST-stale.xml': JUNIT_XML });
    let staleSeenByTool = true;
    simulateTool(async () => {
      staleSeenByTool = await pathExists(stale);
    });

    await gradleJunitAdapter.run(folder, { commandOverride: 'gradle test --offline' });

    expect(lastCommand().command).toBe('gradle test --offline');
    expect(staleSeenByTool).toBe(false);
  });

  it('collects results from each subproject of a multi-project build', async () => {
    simulateTool(() =>
      writeTree(folder, {
        'lib/build/test-results/test/TEST-lib.xml': JUNIT_XML,
        'app/build/test-results/test/TEST-app.xml': JUNIT_XML,
        // Other test tasks are not what `test` ran.
        'app/build/test-results/integrationTest/TEST-it.xml': JUNIT_XML,
      }),
    );

    const result = await gradleJunitAdapter.run(folder, {});

    expect(result.run).toMatchObject({ adapterId: 'gradle-junit', platform: 'jvm' });
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
      await writeTree(folder, { [marker]: '' });
      expect(await pytestAdapter.detect(folder)).toBe(true);
    },
  );

  it('runs pytest as a module and asks for a JUnit XML report in the temp directory', async () => {
    simulateTool();

    await pytestAdapter.run(folder, {});

    const { command } = lastCommand();
    expect(command).toMatch(new RegExp(`^${python} -m pytest --junit-xml="`));
    expect(dirname(reportPathOf(command))).toBe(resolve(tmpdir()));
  });

  it('appends the report flag to a command override', async () => {
    simulateTool();

    await pytestAdapter.run(folder, { commandOverride: 'poetry run pytest -q' });

    expect(lastCommand().command).toMatch(/^poetry run pytest -q --junit-xml=".+\.xml"$/);
  });

  it('parses the report pytest wrote and removes it on cleanup', async () => {
    const fixture = readFixture('junit/sample-pytest-junit.xml');
    let reportPath = '';
    simulateTool(async (command) => {
      reportPath = reportPathOf(command);
      await writeFile(reportPath, fixture, 'utf8');
    });

    const result = await pytestAdapter.run(folder, {});

    expect(result.run).toMatchObject({ adapterId: 'pytest', platform: 'python' });
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
    await writeTree(folder, { [projectFile]: '' });
    expect(await dotnetTestAdapter.detect(folder)).toBe(true);
  });

  it('does not detect a folder that cannot be read', async () => {
    expect(await dotnetTestAdapter.detect(join(folder, 'missing'))).toBe(false);
  });

  it('asks dotnet test for a TRX report in the temp directory', async () => {
    simulateTool();

    await dotnetTestAdapter.run(folder, {});

    const { command } = lastCommand();
    expect(command).toMatch(/^dotnet test --logger "trx;LogFileName=/);
    expect(dirname(trxPathOf(command))).toBe(resolve(tmpdir()));
    expect(trxPathOf(command)).toMatch(/\.trx$/);
  });

  it('appends the report flags to a command override', async () => {
    simulateTool();

    await dotnetTestAdapter.run(folder, { commandOverride: 'dotnet test Calc.Tests' });

    expect(lastCommand().command).toMatch(/^dotnet test Calc\.Tests --logger "trx;/);
  });

  it('parses the TRX report and removes it on cleanup', async () => {
    const fixture = readFixture('dotnet/sample-results.trx');
    let reportPath = '';
    simulateTool(async (command) => {
      reportPath = trxPathOf(command);
      await writeFile(reportPath, fixture, 'utf8');
    });

    const result = await dotnetTestAdapter.run(folder, {});

    expect(result.run).toMatchObject({ adapterId: 'dotnet-test', platform: 'dotnet' });
    expect(result.run.results.map((r) => r.status)).toEqual(['PASSED', 'FAILED', 'SKIPPED']);

    await result.cleanup();
    expect(await pathExists(reportPath)).toBe(false);
  });
});
