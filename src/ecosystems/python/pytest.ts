import { join } from 'node:path';
import { defineAdapter } from '../../runner/define';
import { anyExists, pathExists, readDirSafe } from '../../util/fs';
import { commandExists } from '../../util/shell';
import { parseJUnitXmlFile } from '../../runner/parsers/junit-xml-parser';
import { tempFileReport } from '../../runner/reports';
import { PYTEST_FILE } from './languages';

const DETECT_FILES = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'conftest.py'];

/** Where test files alone, with nothing else to recognise the project by, still count. */
const TEST_FILE_DIRS = ['', 'tests', 'test'];

/** Where `python -m venv` and most tooling put a project's environment. */
const VENV_DIRS = ['.venv', 'venv', 'env'];

async function hasTestFiles(folderPath: string): Promise<boolean> {
  for (const dir of TEST_FILE_DIRS) {
    const entries = await readDirSafe(join(folderPath, dir));
    if (entries.some((entry) => PYTEST_FILE.test(entry.name))) return true;
  }
  return false;
}

/**
 * pytest is usually installed only in the project's venv, which the extension's shell has not
 * activated. Relative, since the command runs in the project folder: no quoting needed.
 */
async function resolvePython(folderPath: string): Promise<string> {
  const isWindows = process.platform === 'win32';
  const interpreter = isWindows ? join('Scripts', 'python.exe') : join('bin', 'python');
  for (const dir of VENV_DIRS) {
    const relativePath = join(dir, interpreter);
    if (await pathExists(join(folderPath, relativePath))) return relativePath;
  }
  if (!isWindows) return 'python3';
  // `python` on Windows is often the Microsoft Store stub, which only offers to install Python.
  return (await commandExists('py')) ? 'py -3' : 'python';
}

export const pytestAdapter = defineAdapter({
  id: 'pytest',
  displayName: 'pytest',
  platform: 'python',

  detect: async (folderPath) => (await anyExists(folderPath, DETECT_FILES)) || hasTestFiles(folderPath),

  async prepare(folderPath, opts) {
    const baseCommand = opts.commandOverride ?? `${await resolvePython(folderPath)} -m pytest`;

    return tempFileReport({
      adapterId: 'pytest',
      extension: 'xml',
      command: (reportPath) => `${baseCommand} --junit-xml="${reportPath}"`,
      parse: parseJUnitXmlFile,
    });
  },
});
