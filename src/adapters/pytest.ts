import { defineAdapter } from './define';
import { anyExists } from '../util/shell';
import { parseJUnitXmlFile } from './parsers/junit-xml-parser';
import { tempFileReport } from './reports';

const DETECT_FILES = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'conftest.py'];

export const pytestAdapter = defineAdapter({
  id: 'pytest',
  displayName: 'pytest',
  language: 'python',

  detect: (folderPath) => anyExists(folderPath, DETECT_FILES),

  async prepare(_folderPath, opts) {
    const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
    const baseCommand = opts.commandOverride ?? `${pythonExe} -m pytest`;

    return tempFileReport({
      adapterId: 'pytest',
      extension: 'xml',
      command: (reportPath) => `${baseCommand} --junit-xml="${reportPath}"`,
      parse: parseJUnitXmlFile,
    });
  },
});
