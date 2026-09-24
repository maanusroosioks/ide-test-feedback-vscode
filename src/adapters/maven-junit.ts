import { join } from 'node:path';
import { defineAdapter } from './define';
import { pathExists } from '../util/shell';
import { junitReportDirs } from './reports';

/** One per module in a reactor build, under `<module>/target/`. */
const REPORT_DIR = 'surefire-reports';

export const mavenJunitAdapter = defineAdapter({
  id: 'maven-junit',
  displayName: 'Maven (JUnit)',
  language: 'java',

  detect: (folderPath) => pathExists(join(folderPath, 'pom.xml')),

  prepare: (folderPath, opts) =>
    junitReportDirs({
      folderPath,
      reportDir: REPORT_DIR,
      command: opts.commandOverride ?? 'mvn -B test',
      logger: opts.logger,
    }),
});
