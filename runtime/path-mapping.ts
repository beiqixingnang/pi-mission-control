import path from "node:path";

export interface PathMapping {
  source: string;
  target: string;
  file?: boolean;
}
const syntax = (value: string) =>
  path.win32.isAbsolute(value) && !value.startsWith("/")
    ? path.win32
    : path.posix;
const absolute = (value: string) => syntax(value).isAbsolute(value);
const relativeTo = (root: string, file: string) => {
  if (syntax(root) !== syntax(file)) return undefined;
  const source = syntax(root),
    relative = source.relative(root, file);
  return !source.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${source.sep}`)
    ? relative.split(source.sep)
    : undefined;
};
const inside = (root: string, file: string) => {
  const relative = relativeTo(root, file);
  return relative !== undefined;
};
/** Follow explicit session migrations, preferring the newest/most specific root.
 * A path already in the current root must not follow an old round-trip alias.
 */
export function mappedPath(
  original: string,
  mappings: PathMapping[],
  currentRoot: string,
): string {
  if (!absolute(original)) return original;
  let value = original;
  const seen = new Set<string>();
  for (let i = 0; i <= mappings.length; i++) {
    const exact = [...mappings]
      .reverse()
      .find((m) => m.file && m.source === value && m.target !== value);
    if (exact) {
      value = exact.target;
      continue;
    }
    if (inside(currentRoot, value)) return value;
    if (seen.has(value))
      throw new Error(
        "Workspace path mapping cycle; inspect the recovery journals",
      );
    seen.add(value);
    const mapping = [...mappings]
      .reverse()
      .filter((m) => m.source !== m.target && inside(m.source, value))
      .sort((a, b) => b.source.length - a.source.length)[0];
    if (!mapping) return value;
    value = path.join(mapping.target, ...relativeTo(mapping.source, value)!);
  }
  throw new Error("Workspace path mapping did not settle");
}
