import { join } from 'node:path';
import { defineAdapter } from '../../runner/define';
import { pathExists } from '../../util/shell';
import { junitReportDirs } from '../../runner/reports';
import { wrapperInvocation } from './wrapper';

/** One per module in a reactor build, under `<module>/target/`. */
const REPORT_DIR = 'surefire-reports';

/**
 * By default a reactor build stops at the first module with a failing test and skips the rest,
 * whose tests would then be missing from the submission without a word.
 */
const TEST_GOAL = '-B test -Dmaven.test.failure.ignore=true';

async function resolveMavenCommand(folderPath: string): Promise<string> {
  const wrapper = await wrapperInvocation(folderPath, { windows: 'mvnw.cmd', posix: 'mvnw' });
  return `${wrapper ?? 'mvn'} ${TEST_GOAL}`;
}

export const mavenJunitAdapter = defineAdapter({
  id: 'maven-junit',
  displayName: 'Maven (JUnit)',
  platform: 'jvm',

  detect: (folderPath) => pathExists(join(folderPath, 'pom.xml')),

  prepare: async (folderPath, opts) =>
    junitReportDirs({
      folderPath,
      reportDir: REPORT_DIR,
      command: opts.commandOverride ?? (await resolveMavenCommand(folderPath)),
      logger: opts.logger,
    }),
});
