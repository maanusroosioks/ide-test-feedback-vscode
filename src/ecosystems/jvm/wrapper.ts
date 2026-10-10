import { join } from 'node:path';
import { pathExists } from '../../util/fs';

export interface WrapperScripts {
  windows: string;
  posix: string;
}

/**
 * The project's build wrapper, if it ships one: it pins the tool's version and needs no install.
 * cmd.exe resolves a bare name against the working directory. Through `sh`, a script unpacked
 * from a zip without its execute bit still runs.
 */
export async function wrapperInvocation(folderPath: string, scripts: WrapperScripts): Promise<string | undefined> {
  const isWindows = process.platform === 'win32';
  const script = isWindows ? scripts.windows : scripts.posix;
  if (!(await pathExists(join(folderPath, script)))) return undefined;
  return isWindows ? script : `sh ./${script}`;
}
