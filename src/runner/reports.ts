import type { Logger } from '../core/ports';
import type { NormalizedTestCase } from '../core/types';
import { cleanupReport, tempReportPath } from '../util/shell';
import type { PreparedRun } from './define';
import { clearReportDirs, parseJUnitXmlDirectory } from './parsers/junit-xml-parser';

export interface TempFileReportOptions {
  adapterId: string;
  extension: string;
  command(reportPath: string): string;
  parse(reportPath: string): Promise<NormalizedTestCase[]>;
}

/** For a tool that is told where to write its one report: a fresh temp file per run, removed on cleanup. */
export function tempFileReport({ adapterId, extension, command, parse }: TempFileReportOptions): PreparedRun {
  const reportPath = tempReportPath(adapterId, extension);
  return {
    command: command(reportPath),
    parse: () => parse(reportPath),
    cleanup: () => cleanupReport(reportPath),
  };
}

export interface JUnitReportDirsOptions {
  folderPath: string;
  /** Matched as a path suffix, see {@link parseJUnitXmlDirectory}. */
  reportDir: string;
  command: string;
  logger?: Logger;
}

/** For a tool that writes JUnit XML into a directory per module it builds. */
export async function junitReportDirs({
  folderPath,
  reportDir,
  command,
  logger,
}: JUnitReportDirsOptions): Promise<PreparedRun> {
  // The tool leaves reports in place for modules it doesn't reach this run.
  await clearReportDirs(folderPath, reportDir);
  return {
    command,
    parse: (startedAt) =>
      parseJUnitXmlDirectory(folderPath, {
        reportDir,
        since: startedAt,
        onWarning: (message) => logger?.log(message),
      }),
  };
}
