import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { describeError, MoodleSubmitError } from '../../core/errors';

/** A report that could not be used — distinct from a run that had no tests. */
export class ReportUnavailableError extends MoodleSubmitError {}

/** Attributes come back as `@_name`, text as `#text`; `arrayTags` are arrays even when they occur once. */
export function createReportParser(arrayTags: string[]): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    // Otherwise a message that happens to be numeric, like `Assert.Fail("42")`, arrives as a number.
    parseTagValue: false,
    isArray: (name) => arrayTags.includes(name),
  });
}

export async function parseReportFile<T>(
  path: string,
  parse: (content: string) => T[],
): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    throw new ReportUnavailableError(`no report was written to ${path} (${describeError(error)})`);
  }

  try {
    return parse(content);
  } catch (error) {
    throw new ReportUnavailableError(`the report at ${path} could not be parsed (${describeError(error)})`);
  }
}
