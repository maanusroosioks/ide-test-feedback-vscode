import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dotnetTestAdapter } from '../../../src/ecosystems/dotnet/dotnet-test';
import { gradleJunitAdapter } from '../../../src/ecosystems/jvm/gradle-junit';
import { mavenJunitAdapter } from '../../../src/ecosystems/jvm/maven-junit';
import { pytestAdapter } from '../../../src/ecosystems/python/pytest';
import { pathExists } from '../../../src/util/fs';
import { commandExists, runCommand, type RunCommandOptions } from '../../../src/util/shell';
import { recordingLogger } from '../helpers/fakes';
import { tempDir, writeTree } from '../helpers/fs';
import { readFixture } from '../helpers/project';

// The real build tools needn't be installed: each test plays the tool by writing the report
// where the real one would.
vi.mock('../../../src/util/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/util/shell')>()),
  runCommand: vi.fn(),
  commandExists: vi.fn(),
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

/** A project wrapper script's file name, and how it is invoked: through sh, one unzipped without its execute bit still runs. */
function wrapperFor(name: string, windowsFile: string): { file: string; invocation: string } {
  return process.platform === 'win32'
    ? { file: windowsFile, invocation: windowsFile }
    : { file: name, invocation: `sh ./${name}` };
}

function lastCommand(): { command: string; options: RunCommandOptions } {
  const [command, options] = vi.mocked(runCommand).mock.lastCall!;
  return { command, options };
}

let folder: string;

beforeEach(async () => {
  vi.mocked(runCommand).mockReset();
  vi.mocked(commandExists).mockReset().mockResolvedValue(false);
  folder = await tempDir();
});

describe('mavenJunitAdapter', () => {
  it('detects a folder with a pom.xml', async () => {
    expect(await mavenJunitAdapter.detect(folder)).toBe(false);
    await writeTree(folder, { 'pom.xml': '<project/>' });
    expect(await mavenJunitAdapter.detect(folder)).toBe(true);
  });

  it('runs mvn in batch mode from the project folder, past modules with failing tests', async () => {
    simulateTool();

    await mavenJunitAdapter.run(folder, {});

    // Without ignoring failures, a reactor build skips every module after the first failing one.
    expect(lastCommand().command).toBe('mvn -B test -Dmaven.test.failure.ignore=true');
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

  it('prefers the project wrapper, so Maven need not be installed', async () => {
    const wrapper = wrapperFor('mvnw', 'mvnw.cmd');
    await writeTree(folder, { [wrapper.file]: '' });
    simulateTool();

    await mavenJunitAdapter.run(folder, {});

    expect(lastCommand().command).toBe(`${wrapper.invocation} -B test -Dmaven.test.failure.ignore=true`);
  });
});

describe('gradleJunitAdapter', () => {

  it.each(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])(
    'detects a folder with %s',
    async (buildFile) => {
      expect(await gradleJunitAdapter.detect(folder)).toBe(false);
      await writeTree(folder, { [buildFile]: '' });
      expect(await gradleJunitAdapter.detect(folder)).toBe(true);
    },
  );

  it('prefers the project wrapper when there is one', async () => {
    const wrapper = wrapperFor('gradlew', 'gradlew.bat');
    await writeTree(folder, { [wrapper.file]: '' });
    simulateTool();

    await gradleJunitAdapter.run(folder, {});

    expect(lastCommand().command).toBe(`${wrapper.invocation} cleanTest test --continue`);
  });

  it('falls back to gradle on PATH without a wrapper, continuing past failing subprojects', async () => {
    simulateTool();

    await gradleJunitAdapter.run(folder, {});

    expect(lastCommand().command).toBe('gradle cleanTest test --continue');
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

  it.each(['test_calc.py', 'calc_test.py', 'tests/test_calc.py', 'test/test_calc.py'])(
    'detects a project with no config, only %s',
    async (testFile) => {
      await writeTree(folder, { 'calc.py': '', 'requirements.txt': '' });
      expect(await pytestAdapter.detect(folder)).toBe(false);

      await writeTree(folder, { [testFile]: '' });
      expect(await pytestAdapter.detect(folder)).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    "prefers the py launcher on Windows, since bare python may be the Store's install stub",
    async () => {
      vi.mocked(commandExists).mockResolvedValue(true);
      simulateTool();

      await pytestAdapter.run(folder, {});

      expect(commandExists).toHaveBeenCalledWith('py');
      expect(lastCommand().command).toMatch(/^py -3 -m pytest --junit-xml="/);
    },
  );

  it('runs pytest as a module and asks for a JUnit XML report in a fresh directory under the temp directory', async () => {
    simulateTool();

    await pytestAdapter.run(folder, {});

    const { command } = lastCommand();
    expect(command).toMatch(new RegExp(`^${python} -m pytest --junit-xml="`));
    const reportDir = dirname(reportPathOf(command));
    expect(dirname(reportDir)).toBe(resolve(tmpdir()));
    expect(await pathExists(reportDir)).toBe(true);
  });

  it('appends the report flag to a command override', async () => {
    simulateTool();

    await pytestAdapter.run(folder, { commandOverride: 'poetry run pytest -q' });

    expect(lastCommand().command).toMatch(/^poetry run pytest -q --junit-xml=".+\.xml"$/);
  });

  it.each(['.venv', 'venv', 'env'])("uses the project's %s interpreter, which has pytest installed", async (venv) => {
    const interpreter = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
    await writeTree(folder, { [interpreter]: '' });
    simulateTool();

    await pytestAdapter.run(folder, {});

    expect(lastCommand().command.startsWith(`${interpreter} -m pytest --junit-xml="`)).toBe(true);
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
    expect(await pathExists(dirname(reportPath))).toBe(false);
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
  function reportDirOf(command: string): string {
    const dir = /--results-directory "([^"]+)"/.exec(command)?.[1];
    if (!dir) throw new Error(`no --results-directory flag in: ${command}`);
    return dir;
  }

  /** Plays `dotnet test`, which creates the results directory and names each project's TRX itself. */
  function writeReports(reports: Record<string, string>): ToolBehavior {
    return async (command) => {
      const dir = reportDirOf(command);
      await mkdir(dir, { recursive: true });
      for (const [name, content] of Object.entries(reports)) {
        await writeFile(join(dir, name), content, 'utf8');
      }
    };
  }

  it.each(['App.csproj', 'App.sln', 'App.slnx'])('detects a folder with %s', async (projectFile) => {
    expect(await dotnetTestAdapter.detect(folder)).toBe(false);
    await writeTree(folder, { [projectFile]: '' });
    expect(await dotnetTestAdapter.detect(folder)).toBe(true);
  });

  it('does not detect a folder that cannot be read', async () => {
    expect(await dotnetTestAdapter.detect(join(folder, 'missing'))).toBe(false);
  });

  it('asks dotnet test for TRX reports in a fresh temp directory, leaving the file names to it', async () => {
    simulateTool();

    await dotnetTestAdapter.run(folder, {});

    const { command } = lastCommand();
    expect(command).toMatch(/^dotnet test --logger trx --results-directory "/);
    expect(command).not.toContain('LogFileName');
    expect(dirname(reportDirOf(command))).toBe(resolve(tmpdir()));
  });

  it.each(['Calc.sln', 'Calc.slnx'])(
    'targets the solution %s when it sits next to a project, which bare dotnet test refuses',
    async (solution) => {
      await writeTree(folder, { [solution]: '', 'Calc.csproj': '' });
      simulateTool();

      await dotnetTestAdapter.run(folder, {});

      expect(lastCommand().command.startsWith(`dotnet test "${solution}" --logger trx `)).toBe(true);
    },
  );

  it('finds a test project in its own folder when there is no solution', async () => {
    await writeTree(folder, { 'Calc/Calc.csproj': '', 'Calc.Tests/Calc.Tests.csproj': '' });
    expect(await dotnetTestAdapter.detect(folder)).toBe(true);
    simulateTool();

    await dotnetTestAdapter.run(folder, {});

    expect(lastCommand().command).toMatch(/^dotnet test "Calc\.Tests\/Calc\.Tests\.csproj" --logger trx /);
  });

  it('explains what to do with several test projects and no solution', async () => {
    await writeTree(folder, { 'A.Tests/A.Tests.csproj': '', 'B.Tests/B.Tests.csproj': '' });
    simulateTool();

    await expect(dotnetTestAdapter.run(folder, {})).rejects.toThrow(/dotnet new sln/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('does not detect a folder whose subfolders hold only non-test projects', async () => {
    await writeTree(folder, { 'Calc/Calc.csproj': '' });
    expect(await dotnetTestAdapter.detect(folder)).toBe(false);
  });

  it.each(['Calc.Tests', 'Calc_Test', 'Calc-tests', 'CalcTests', 'Calc2Test', 'Tests'])(
    'takes %s.csproj one folder down for a test project',
    async (name) => {
      await writeTree(folder, { [`${name}/${name}.csproj`]: '' });
      expect(await dotnetTestAdapter.detect(folder)).toBe(true);
    },
  );

  it.each(['Latest', 'Contest', 'Attest', 'Contests'])(
    'does not take %s.csproj for a test project just for ending in "test"',
    async (name) => {
      await writeTree(folder, { [`${name}/${name}.csproj`]: '' });
      expect(await dotnetTestAdapter.detect(folder)).toBe(false);
    },
  );

  it('leaves a lone project to dotnet test', async () => {
    await writeTree(folder, { 'Calc.Tests.csproj': '' });
    simulateTool();

    await dotnetTestAdapter.run(folder, {});

    expect(lastCommand().command).toMatch(/^dotnet test --logger trx /);
  });

  it('appends the report flags to a command override', async () => {
    simulateTool();

    await dotnetTestAdapter.run(folder, { commandOverride: 'dotnet test Calc.Tests' });

    expect(lastCommand().command).toMatch(/^dotnet test Calc\.Tests --logger trx --results-directory "/);
  });

  it('parses the TRX report and removes its directory on cleanup', async () => {
    simulateTool(writeReports({ 'run.trx': readFixture('dotnet/sample-results.trx') }));

    const result = await dotnetTestAdapter.run(folder, {});
    const dir = reportDirOf(lastCommand().command);

    expect(result.run).toMatchObject({ adapterId: 'dotnet-test', platform: 'dotnet' });
    expect(result.run.results.map((r) => r.status)).toEqual(['PASSED', 'FAILED', 'SKIPPED']);

    await result.cleanup();
    expect(await pathExists(dir)).toBe(false);
  });

  it('keeps the results of every test project in a solution', async () => {
    const fixture = readFixture('dotnet/sample-results.trx');
    simulateTool(writeReports({ 'a_Calc.Tests.trx': fixture, 'b_Parser.Tests.trx': fixture, 'notes.txt': 'x' }));

    const result = await dotnetTestAdapter.run(folder, {});

    expect(result.run.results).toHaveLength(6);
  });

  it.each([
    ['no results directory', undefined],
    ['a results directory with no TRX in it', { 'notes.txt': 'x' }],
  ])('explains %s rather than reporting zero tests', async (_label, reports) => {
    simulateTool(reports && writeReports(reports));

    const result = await dotnetTestAdapter.run(folder, {});

    expect(result.run.results).toEqual([]);
    expect(result.reportError).toContain('no TRX report was written');
  });
});
