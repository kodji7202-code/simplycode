// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * `path` is inside `root`, or is it. Relative segments like `..` are answered
 * lexically here; callers check the canonical path, which is already resolved.
 */
export function pathIsWithinRoot(path: string, root: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

/**
 * `..` must climb out of the real directory a symlinked parent points at, not
 * out of the path's text — `linked/../x` through a symlink escapes wherever
 * `linked` resolves to. Resolving each parent segment against the canonical
 * prefix keeps that true; a prefix that cannot be canonicalized fails closed.
 */
const physicallyResolvedPath = (path: string): string | undefined => {
  const parsed = NodePath.parse(path);
  let current = parsed.root;
  // Paths arrive with either separator regardless of platform.
  for (const segment of path.slice(parsed.root.length).split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const canonical = canonicalPathForContainment(current);
      if (canonical === undefined) return undefined;
      current = NodePath.dirname(canonical);
      continue;
    }
    current = NodePath.join(current, segment);
  }
  return current;
};

/**
 * The canonical path containment compares: symlinks and `..` resolve first, and
 * a not-yet-existing path resolves through its nearest existing ancestor.
 * Errors and non-ENOENT stat failures return undefined (fail closed).
 */
export function canonicalPathForContainment(path: string): string | undefined {
  const resolved = physicallyResolvedPath(path);
  if (resolved === undefined) return undefined;
  let candidate = resolved;
  const missingSuffix: Array<string> = [];

  while (true) {
    try {
      return NodePath.resolve(NodeFS.realpathSync.native(candidate), ...missingSuffix);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    try {
      NodeFS.lstatSync(candidate);
      return undefined;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    const parent = NodePath.dirname(candidate);
    if (parent === candidate) return undefined;
    missingSuffix.unshift(NodePath.basename(candidate));
    candidate = parent;
  }
}

/**
 * A permission-request path made absolute: absolute paths pass through, relative
 * ones join `cwd`. Empty input, or a relative path with no cwd to resolve
 * against, returns undefined.
 */
export function resolveContainedPath(
  path: string,
  cwd: string | null | undefined,
): string | undefined {
  const trimmed = path.trim();
  if (trimmed.length === 0) return undefined;
  if (NodePath.isAbsolute(trimmed)) return trimmed;
  if (cwd === null || cwd === undefined || cwd.trim().length === 0) return undefined;
  return `${cwd}${cwd.endsWith(NodePath.sep) ? "" : NodePath.sep}${trimmed}`;
}

/**
 * Whether `candidate` resolves inside one of `roots`, on canonical paths: the
 * candidate and each root are realpath-resolved first, so a symlinked root or a
 * `..` through a symlinked parent cannot fake containment. A root or candidate
 * that cannot be resolved fails closed.
 */
export function pathContainedInRoots(candidate: string, roots: ReadonlyArray<string>): boolean {
  const canonicalCandidate = canonicalPathForContainment(candidate);
  if (canonicalCandidate === undefined) return false;
  for (const root of roots) {
    const canonicalRoot = canonicalPathForContainment(root);
    if (canonicalRoot !== undefined && pathIsWithinRoot(canonicalCandidate, canonicalRoot)) {
      return true;
    }
  }
  return false;
}
