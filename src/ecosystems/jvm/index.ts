import type { Ecosystem } from '../types';
import { gradleJunitAdapter } from './gradle-junit';
import { javaSource, kotlinSource } from './languages';
import { mavenJunitAdapter } from './maven-junit';
import { jvmPlatform } from './platform';

export const jvmEcosystem = {
  platform: jvmPlatform,
  languages: { java: javaSource, kotlin: kotlinSource },
  adapters: [mavenJunitAdapter, gradleJunitAdapter],
} satisfies Ecosystem;
