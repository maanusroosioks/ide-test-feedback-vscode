import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { MoodleSubmitError } from '../../core/errors';
import { defineAdapter } from '../../runner/define';
import { parseTrxDirectory } from '../../runner/parsers/trx-parser';
import { tempDirReport } from '../../runner/reports';
import { readDirSafe } from '../../util/fs';
import { isWalkableDir } from '../../util/paths';
import { dotnetPlatform } from './platform';

/** `.slnx` is what `dotnet new sln` writes on newer SDKs. */
const SOLUTION_EXTENSIONS = ['.sln', '.slnx'];
const PROJECT_EXTENSIONS = ['.csproj', ...SOLUTION_EXTENSIONS];

/** `Calc.Tests.csproj`, `Calc_Test.csproj`, `CalcTests.csproj`, `Tests.csproj` — not `Latest.csproj`. */
const TEST_PROJECT = /(?:^|[._-]|[a-z\d](?=T))[Tt]ests?\.csproj$/;

const IGNORED_DIRS = new Set(dotnetPlatform.ignoredDirs);

const isSolution = (name: string): boolean => SOLUTION_EXTENSIONS.some((ext) => name.endsWith(ext));
const isProjectFile = (name: string): boolean => PROJECT_EXTENSIONS.some((ext) => name.endsWith(ext));

/** A layout without a solution keeps each project in its own folder: `Calculator.Tests/Calculator.Tests.csproj`. */
async function nestedTestProjects(folderPath: string, entries: Dirent[]): Promise<string[]> {
  const folders = entries.filter((entry) => entry.isDirectory() && isWalkableDir(entry.name, IGNORED_DIRS));
  const nested = await Promise.all(
    folders.map(async (folder) =>
      (await readDirSafe(join(folderPath, folder.name)))
        .filter((entry) => entry.isFile() && TEST_PROJECT.test(entry.name))
        .map((entry) => `${folder.name}/${entry.name}`),
    ),
  );
  return nested.flat().sort();
}

interface DotnetTargets {
  /** Project and solution files directly in the folder. */
  root: string[];
  /** Test projects one folder down; only looked for when `root` is empty. */
  nested: string[];
}

async function findTargets(folderPath: string): Promise<DotnetTargets> {
  const entries = await readDirSafe(folderPath);
  const root = entries.filter((entry) => entry.isFile() && isProjectFile(entry.name)).map((entry) => entry.name);
  return { root, nested: root.length > 0 ? [] : await nestedTestProjects(folderPath, entries) };
}

/**
 * Bare `dotnet test` refuses a folder holding more than one project or solution file (MSB1011),
 * as after `dotnet new sln` next to a project, and finds nothing in a folder holding none.
 */
async function resolveDotnetCommand(folderPath: string): Promise<string> {
  const { root, nested } = await findTargets(folderPath);
  if (root.length > 0) {
    const solutions = root.filter(isSolution);
    return root.length > 1 && solutions.length === 1 ? `dotnet test "${solutions[0]}"` : 'dotnet test';
  }
  if (nested.length > 1) {
    throw new MoodleSubmitError(
      `Found several test projects (${nested.join(', ')}) but no solution to run them together. ` +
        'Add one with "dotnet new sln" and "dotnet sln add", or set ideTestFeedback.testCommandOverrides.',
    );
  }
  // Nothing found at all only happens when preferredAdapter forces this adapter; dotnet explains.
  return nested.length === 1 ? `dotnet test "${nested[0]}"` : 'dotnet test';
}

export const dotnetTestAdapter = defineAdapter({
  id: 'dotnet-test',
  displayName: '.NET (dotnet test)',
  platform: 'dotnet',

  async detect(folderPath) {
    const { root, nested } = await findTargets(folderPath);
    return root.length > 0 || nested.length > 0;
  },

  // No `LogFileName`: with several test projects each would overwrite the same file. Left to name
  // its own, the logger keeps one report per project.
  async prepare(folderPath, opts) {
    const baseCommand = opts.commandOverride ?? (await resolveDotnetCommand(folderPath));

    return tempDirReport({
      adapterId: 'dotnet-test',
      command: (reportDir) => `${baseCommand} --logger trx --results-directory "${reportDir}"`,
      parse: parseTrxDirectory,
    });
  },
});
