import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

export interface WorkerCatalogEntry {
  name: string;
  description: string;
  source: string;
}

function vendoredRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(moduleDir, "hidden-workers", "agency-agents");
}

async function walkMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkMarkdownFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results;
}

function parseFrontmatter(raw: string): { name: string; description: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();

  if (!name || !description) return null;
  return { name, description };
}

export async function loadWorkerCatalog(workdir: string): Promise<{
  roots: string[];
  workers: WorkerCatalogEntry[];
}> {
  void workdir;

  const root = vendoredRoot();
  const roots = existsSync(root) ? [root] : [];
  const workers = new Map<string, WorkerCatalogEntry>();

  for (const root of roots) {
    const files = await walkMarkdownFiles(root);
    for (const file of files) {
      try {
        const raw = await readFile(file, "utf-8");
        const parsed = parseFrontmatter(raw);
        if (!parsed) continue;
        if (!workers.has(parsed.name)) {
          workers.set(parsed.name, {
            name: parsed.name,
            description: parsed.description,
            source: file,
          });
        }
      } catch {
        // Ignore unreadable files and keep catalog best-effort.
      }
    }
  }

  return {
    roots,
    workers: [...workers.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
