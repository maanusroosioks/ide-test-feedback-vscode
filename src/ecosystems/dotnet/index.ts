import type { Ecosystem } from '../types';
import { dotnetTestAdapter } from './dotnet-test';
import { csharpSource } from './languages';
import { dotnetPlatform } from './platform';

export const dotnetEcosystem = {
  platform: dotnetPlatform,
  languages: { csharp: csharpSource },
  adapters: [dotnetTestAdapter],
} satisfies Ecosystem;
