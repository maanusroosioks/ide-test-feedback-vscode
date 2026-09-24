export type SourceLanguage = 'python' | 'java' | 'kotlin' | 'csharp';

export interface TestDeclaration {
  name: string;
  /** Dotted outermost-first. Absent for a module-level function. */
  container?: string;
  /** 1-based, the first decorator/annotation/attribute line. */
  startLine: number;
  /** 1-based inclusive. */
  endLine: number;
  markers: string[];
  containerMarkers: string[];
  /** Excludes the signature and markers. */
  bodyText: string;
}
