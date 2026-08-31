import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { createRequire } from "node:module";
import * as ts from "typescript";

async function collectTsFiles(root) {
  const output = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) output.push(path);
    }
  }
  await walk(root);
  return output;
}

export async function compileMigrationModules() {
  const repoRoot = process.cwd();
  const sourceRoot = join(repoRoot, "lib", "migrations");
  const tempRoot = await mkdtemp(join(repoRoot, ".tmp-migration-modules-"));
  for (const sourcePath of await collectTsFiles(sourceRoot)) {
    const rel = relative(sourceRoot, sourcePath).replace(/\.ts$/, ".js");
    const targetPath = join(tempRoot, rel);
    await mkdir(dirname(targetPath), { recursive: true });
    const source = await readFile(sourcePath, "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        esModuleInterop: true,
      },
      fileName: sourcePath,
    });
    await writeFile(targetPath, transpiled.outputText, "utf8");
  }
  const requireFromHere = createRequire(import.meta.url);
  return {
    requireModule(relativeJsPath) {
      return requireFromHere(join(tempRoot, relativeJsPath));
    },
    async cleanup() { await rm(tempRoot, { recursive: true, force: true }); },
  };
}
