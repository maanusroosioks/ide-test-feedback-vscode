export interface TestDeclaration {
  name: string;
  /** Dotted outermost-first. Absent for a module-level function. */
  container?: string;
  /** 1-based, the first decorator/annotation/attribute line. */
  startLine: number;
  /** 1-based inclusive. */
  endLine: number;
  markers: string[];
  /** Every enclosing type's, outermost first: a skip on an outer class reaches its nested ones. */
  containerMarkers: string[];
  /** Excludes the signature and markers. */
  bodyText: string;
}
