import type { Ecosystem } from '../types';
import { pythonSource } from './languages';
import { pythonPlatform } from './platform';
import { pytestAdapter } from './pytest';

export const pythonEcosystem = {
  platform: pythonPlatform,
  languages: { python: pythonSource },
  adapters: [pytestAdapter],
} satisfies Ecosystem;
