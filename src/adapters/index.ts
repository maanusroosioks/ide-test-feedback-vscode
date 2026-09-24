import { dotnetTestAdapter } from './dotnet-test';
import { gradleJunitAdapter } from './gradle-junit';
import { mavenJunitAdapter } from './maven-junit';
import { pytestAdapter } from './pytest';
import type { TestRunnerAdapter } from './types';

/**
 * In detection priority order: the first match wins when there is no picker. Each id must also be
 * listed in `moodleSubmit.preferredAdapter`'s enum in package.json — a unit test checks that.
 */
export const ALL_ADAPTERS: readonly TestRunnerAdapter[] = [
  mavenJunitAdapter,
  gradleJunitAdapter,
  pytestAdapter,
  dotnetTestAdapter,
];
