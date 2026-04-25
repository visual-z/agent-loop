import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";

export interface WorkerCatalogEntry {
  /** Stable slug used as the persona_id passed to agent_loop_dispatch */
  persona_id: string;
  /** Human-readable name from the file's frontmatter */
  name: string;
  /** Short description for orchestrator selection */
  description: string;
  /** Absolute source path */
  source: string;
  /** Category derived from the parent directory under agency-agents/ */
  category: string;
}

export interface FullCatalogEntry extends WorkerCatalogEntry {
  /** Full persona body (file content with frontmatter stripped) */
  persona_body: string;
}

let slimCatalogCache: { roots: string[]; workers: WorkerCatalogEntry[] } | null = null;
let fullCatalogCache: { roots: string[]; workers: FullCatalogEntry[] } | null = null;

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

interface ParsedFile {
  name: string;
  description: string;
  body: string;
}

function parseFrontmatter(raw: string): { name: string; description: string; bodyStart: number } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;

  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();

  if (!name || !description) return null;
  return { name, description, bodyStart: match[0].length };
}

function parseFile(raw: string): ParsedFile | null {
  const fm = parseFrontmatter(raw);
  if (!fm) return null;

  const body = raw.slice(fm.bodyStart).trim();
  return { name: fm.name, description: fm.description, body };
}

/** Slugify a file path under agency-agents/ to produce a stable persona_id. */
function personaIdFromPath(file: string, catalogRoot: string): string {
  const rel = relative(catalogRoot, file);
  const noExt = rel.replace(/\.md$/, "");
  // path/to/foo-bar -> path-to-foo-bar (lowercase, ascii-safe)
  return noExt
    .replace(/[\\/]/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
}

function categoryFromPath(file: string, catalogRoot: string): string {
  const rel = relative(catalogRoot, file);
  const parts = rel.split(/[\\/]/);
  return parts.length > 1 ? parts[0] : "uncategorized";
}

/**
 * Load the full catalog including persona body. Used internally by the
 * dispatch path to inject the persona prefix into the worker prompt.
 */
export async function loadFullCatalog(): Promise<{
  roots: string[];
  workers: FullCatalogEntry[];
}> {
  if (fullCatalogCache) return fullCatalogCache;

  const root = vendoredRoot();
  const roots = existsSync(root) ? [root] : [];
  const workers = new Map<string, FullCatalogEntry>();

  for (const r of roots) {
    const files = await walkMarkdownFiles(r);
    for (const file of files) {
      try {
        const raw = await readFile(file, "utf-8");
        const parsed = parseFile(raw);
        if (!parsed) continue;
        const persona_id = personaIdFromPath(file, r);
        if (workers.has(persona_id)) continue;
        workers.set(persona_id, {
          persona_id,
          name: parsed.name,
          description: parsed.description,
          source: file,
          category: categoryFromPath(file, r),
          persona_body: parsed.body,
        });
      } catch {
        // best-effort
      }
    }
  }

  fullCatalogCache = {
    roots,
    workers: [...workers.values()].sort((a, b) =>
      a.persona_id.localeCompare(b.persona_id)
    ),
  };
  return fullCatalogCache;
}

/**
 * Slim catalog (no persona body) returned to the orchestrator via
 * agent_loop_list_workers. Body is fetched separately at dispatch time so the
 * orchestrator's context stays small.
 */
export async function loadWorkerCatalog(workdir: string): Promise<{
  roots: string[];
  workers: WorkerCatalogEntry[];
}> {
  void workdir;
  if (slimCatalogCache) return slimCatalogCache;

  const root = vendoredRoot();
  const roots = existsSync(root) ? [root] : [];
  const workers = new Map<string, WorkerCatalogEntry>();

  for (const r of roots) {
    const files = await walkMarkdownFiles(r);
    for (const file of files) {
      try {
        const raw = await readFile(file, "utf-8");
        const parsed = parseFrontmatter(raw);
        if (!parsed) continue;
        const persona_id = personaIdFromPath(file, r);
        if (workers.has(persona_id)) continue;
        workers.set(persona_id, {
          persona_id,
          name: parsed.name,
          description: parsed.description,
          source: file,
          category: categoryFromPath(file, r),
        });
      } catch {
        // best-effort
      }
    }
  }

  slimCatalogCache = {
    roots,
    workers: [...workers.values()].sort((a, b) =>
      a.persona_id.localeCompare(b.persona_id)
    ),
  };
  return slimCatalogCache;
}

/** Look up a single persona body by id. Returns null if unknown. */
export async function getPersonaBody(personaId: string): Promise<{
  persona_id: string;
  name: string;
  body: string;
} | null> {
  const full = await loadFullCatalog();
  const hit = full.workers.find((w) => w.persona_id === personaId);
  if (!hit) return null;
  return {
    persona_id: hit.persona_id,
    name: hit.name,
    body: hit.persona_body,
  };
}
