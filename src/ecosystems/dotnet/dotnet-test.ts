import { readdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { defineAdapter } from '../../runner/define';
import { parseTrxFile } from '../../runner/parsers/trx-parser';
import { tempFileReport } from '../../runner/reports';

const PROJECT_EXTENSIONS = ['.csproj', '.sln'];

export const dotnetTestAdapter = defineAdapter({
  id: 'dotnet-test',
  displayName: '.NET (dotnet test)',
  platform: 'dotnet',

  async detect(folderPath) {
    try {
      const entries = await readdir(folderPath);
      return entries.some((name) => PROJECT_EXTENSIONS.some((ext) => name.endsWith(ext)));
    } catch {
      return false;
    }
  },

  async prepare(_folderPath, opts) {
    const baseCommand = opts.commandOverride ?? 'dotnet test';

    return tempFileReport({
      adapterId: 'dotnet-test',
      extension: 'trx',
      command: (reportPath) =>
        `${baseCommand} --logger "trx;LogFileName=${basename(reportPath)}" --results-directory "${dirname(reportPath)}"`,
      parse: parseTrxFile,
    });
  },
});
