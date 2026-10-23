import path from "node:path";

export interface PathMapping {
  source: string;
  target: string;
}
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
};
/** Follow explicit session migrations, preferring the newest/most specific root.
 * A path already in the current root must not follow an old round-trip alias.
 */
export function mappedPath(
  original: string,
  mappings: PathMapping[],
  currentRoot: string,
): string {
  if (!path.isAbsolute(original)) return original;
  let value = original;
  const seen = new Set<string>();
  for (let i = 0; i <= mappings.length; i++) {
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
    value = path.join(mapping.target, path.relative(mapping.source, value));
  }
  throw new Error("Workspace path mapping did not settle");
}
