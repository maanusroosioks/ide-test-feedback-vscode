import { join } from 'node:path';
import { defineAdapter } from './define';
import { anyExists, pathExists } from '../util/shell';
import { junitReportDirs } from './reports';

/** Matched as a path suffix: a multi-project build writes one per subproject. */
const REPORT_DIR = 'build/test-results/test';

const BUILD_FILES = ['build.gradle', 'build.gradle.kts'];

async function resolveGradleCommand(folderPath: string): Promise<string> {
  const isWindows = process.platform === 'win32';
  const wrapper = isWindows ? 'gradlew.bat' : 'gradlew';
  // cmd.exe resolves a bare name against the working directory; sh does not.
  const invocation = isWindows ? wrapper : `./${wrapper}`;
  return (await pathExists(join(folderPath, wrapper)))
    ? `${invocation} cleanTest test`
    : 'gradle cleanTest test';
}

export const gradleJunitAdapter = defineAdapter({
  id: 'gradle-junit',
  displayName: 'Gradle (JUnit)',
  platform: 'jvm',

  detect: (folderPath) => anyExists(folderPath, BUILD_FILES),

  // `cleanTest` covers the default command; clearing the report dirs also covers overrides without it.
  async prepare(folderPath, opts) {
    return junitReportDirs({
      folderPath,
      reportDir: REPORT_DIR,
      command: opts.commandOverride ?? (await resolveGradleCommand(folderPath)),
      logger: opts.logger,
    });
  },
});
