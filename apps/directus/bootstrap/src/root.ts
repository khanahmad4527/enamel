import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the repository starts.
 *
 * `brand/`, `demo/` and `.env` live at the root, and this package used to
 * reach them by counting directories: `join(__dirname, "..", "..",
 * "brand")`. That is correct exactly until somebody moves the package,
 * and when the repo became a workspace and `bootstrap/` moved two levels
 * deeper every one of those paths broke at once — with `ENOENT` in the
 * middle of provisioning rather than anything that named the cause.
 *
 * Walking up for the workspace marker instead is a few lines and survives
 * the next move. The marker is `pnpm-workspace.yaml`: it exists only at
 * the root, by definition.
 */
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 10; up++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "cannot find the repository root — no pnpm-workspace.yaml above this package",
  );
}

export const REPO_ROOT = findRoot();

/** A path relative to the repository root. */
export const fromRoot = (...parts: string[]): string => join(REPO_ROOT, ...parts);
