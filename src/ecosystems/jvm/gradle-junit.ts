import { defineAdapter } from '../../runner/define';
import { anyExists } from '../../util/shell';
import { junitReportDirs } from '../../runner/reports';
import { wrapperInvocation } from './wrapper';

/** Matched as a path suffix: a multi-project build writes one per subproject. */
const REPORT_DIR = 'build/test-results/test';

/** A multi-project build may keep its build files in the subprojects, leaving only settings at the root. */
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];

/** `--continue`: otherwise the first subproject with a failing test stops the others' tests from running. */
const TEST_TASKS = 'cleanTest test --continue';

async function resolveGradleCommand(folderPath: string): Promise<string> {
  const wrapper = await wrapperInvocation(folderPath, { windows: 'gradlew.bat', posix: 'gradlew' });
  return `${wrapper ?? 'gradle'} ${TEST_TASKS}`;
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
