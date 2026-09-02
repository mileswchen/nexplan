import { DocMeta } from './types.js';

// Minimal YAML-ish frontmatter parser/serializer. It intentionally supports a
// small, safe subset (flat keys: strings, numbers, booleans, and inline string
// arrays) — enough for the controlled NexPlan doc metadata.

const DELIM = '---';

interface Parsed {
  meta: Record<string, unknown>;
  body: string;
}

/** Parse a markdown file containing optional `---`-delimited frontmatter. */
export function parseFrontmatter(source: string): Parsed {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== DELIM) {
    return { meta: {}, body: source };
  }
  const end = lines.indexOf(DELIM, 1);
  if (end === -1) {
    return { meta: {}, body: source };
  }
  const metaLines = lines.slice(1, end);
  const bodyLines = lines.slice(end + 1);
  const meta: Record<string, unknown> = {};
  for (const raw of metaLines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      meta[key] = inner
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      meta[key] = Number(value);
    } else if (value === 'true' || value === 'false') {
      meta[key] = value === 'true';
    } else {
      meta[key] = value;
    }
  }
  const body = bodyLines.join('\n').replace(/^\n+/, '');
  return { meta, body };
}

/** Serialize meta + body back into a markdown file with frontmatter. */
export function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  const lines: string[] = [DELIM];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const items = value.map((v) => (typeof v === 'string' ? `"${v}"` : String(v))).join(', ');
      lines.push(`${key}: [${items}]`);
    } else if (typeof value === 'string') {
      lines.push(`${key}: ${value.includes('"') ? JSON.stringify(value) : value}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push(DELIM, '');
  const normalized = body.replace(/^\n+/, '').replace(/\n+$/, '') ;
  if (normalized.length > 0) lines.push(normalized, '');
  return lines.join('\n');
}

const NOW = (): string => new Date().toISOString();

const META_KEYS: (keyof DocMeta)[] = [
  'title',
  'type',
  'status',
  'version',
  'tags',
  'createdBy',
  'createdAt',
  'updatedAt',
  'updatedBy',
];

/** Coerce parsed frontmatter into a complete DocMeta with defaults. */
export function coerceDocMeta(raw: Record<string, unknown>): DocMeta {
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) {
    if (raw[k] !== undefined && raw[k] !== null) meta[k] = raw[k];
  }
  return {
    title: typeof meta.title === 'string' && meta.title ? meta.title : 'Untitled',
    type: validDocType(meta.type),
    status: validDocStatus(meta.status),
    version: typeof meta.version === 'number' && meta.version > 0 ? meta.version : 1,
    tags: Array.isArray(meta.tags) ? (meta.tags as string[]).map(String) : [],
    createdBy: (meta.createdBy as string) || 'user',
    createdAt: (meta.createdAt as string) || NOW(),
    updatedAt: (meta.updatedAt as string) || NOW(),
    updatedBy: (meta.updatedBy as string) || 'user',
  };
}

function validDocType(v: unknown): DocMeta['type'] {
  return ['design', 'decision', 'adr', 'architecture', 'notes'].includes(String(v))
    ? (v as DocMeta['type'])
    : 'notes';
}

function validDocStatus(v: unknown): DocMeta['status'] {
  return ['draft', 'review', 'approved', 'superseded'].includes(String(v))
    ? (v as DocMeta['status'])
    : 'draft';
}

export { NOW };
