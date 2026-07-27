export type Baseline = { contents: string };

/** Components are capitalised; anything else in the file is not the surface. */
const NAMED_EXPORT = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Z][A-Za-z0-9_]*)/;
const DEFAULT_EXPORT = /export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Z][A-Za-z0-9_]*)/;
const BARE_DEFAULT = /export\s+default\s/;

/**
 * A baseline that re-exports the real component rather than copying it.
 *
 * Copying would freeze the comparison against a duplicate of the user's own
 * code: edit the real component afterwards and the baseline silently stops
 * being the baseline. Re-exporting keeps it live.
 *
 * This pattern was not designed; an agent used it in place of the scaffold's
 * placeholder, and it is plainly better than what the template suggested.
 */
export function baselineFrom(
  surface: string,
  sourcePath: string,
  sourceContents: string,
): Baseline | null {
  const normalised = sourcePath.replace(/\\/g, "/");
  const withoutExtension = normalised.replace(/\.[jt]sx?$/, "");
  // .leglas/variants/<surface>/ is three levels down from the project root.
  const importPath = `../../../${withoutExtension}`;

  const defaultMatch = DEFAULT_EXPORT.exec(sourceContents);
  const namedMatch = NAMED_EXPORT.exec(sourceContents);

  let name: string;
  let importLine: string;

  if (namedMatch?.[1]) {
    name = namedMatch[1];
    importLine = `import { ${name} } from "${importPath}";`;
  } else if (defaultMatch?.[1]) {
    name = defaultMatch[1];
    importLine = `import ${name} from "${importPath}";`;
  } else if (BARE_DEFAULT.test(sourceContents)) {
    // An anonymous default still works; the local name is ours to choose.
    name = `${surface.charAt(0).toUpperCase()}${surface.slice(1)}Current`;
    importLine = `import ${name} from "${importPath}";`;
  } else {
    return null;
  }

  return {
    contents: `// The current design, re-exported from ${normalised} rather than copied,
// so this baseline stays live: change that component and the comparison
// changes with it.
${importLine}

export function Current() {
  return <${name} />;
}
`,
  };
}
