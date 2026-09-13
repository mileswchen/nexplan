import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const htmlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html');

/** Pull the I18N dictionaries and every key the markup/scripts reference. */
async function loadAnalysis() {
  const html = await readFile(htmlPath, 'utf8');
  // Slice the I18N object literal so CSS declarations are never mistaken for keys.
  const start = html.indexOf('const I18N = {');
  const end = html.indexOf('\n};', start);
  const block = html.slice(start, end);
  const enStart = block.indexOf('  en: {');
  const zhStart = block.indexOf('  zh: {');
  // Dictionary entries are packed several per line. Keys only ever start a line
  // (after 4 spaces) or follow a comma, which keeps colons inside values (e.g.
  // `'Permissions: '`) from being mistaken for keys.
  const keys = (section: string) =>
    new Set([...(section.matchAll(/(?:\n\s{4}|,\s)([a-z0-9_]+):\s*'/g))].map((m) => m[1]));
  const en = keys(block.slice(enStart, zhStart));
  const zh = keys(block.slice(zhStart));
  const used = new Set([
    ...[...html.matchAll(/\bt\('([a-z0-9_]+)'\)/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n(?:-ph)?="([a-z0-9_]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/\bfmt\('([a-z0-9_]+)'/g)].map((m) => m[1]),
  ]);
  return { en, zh, used };
}

describe('dashboard i18n', () => {
  it('defines every referenced key in both English and Chinese', async () => {
    const { en, zh, used } = await loadAnalysis();
    const missingEn = [...used].filter((k) => !en.has(k)).sort();
    const missingZh = [...used].filter((k) => !zh.has(k)).sort();
    expect(missingEn, `keys missing from I18N.en: ${missingEn.join(', ')}`).toEqual([]);
    expect(missingZh, `keys missing from I18N.zh: ${missingZh.join(', ')}`).toEqual([]);
  });

  it('keeps the two dictionaries in step (no key present in only one language)', async () => {
    const { en, zh } = await loadAnalysis();
    const onlyEn = [...en].filter((k) => !zh.has(k)).sort();
    const onlyZh = [...zh].filter((k) => !en.has(k)).sort();
    expect(onlyEn, `only in en: ${onlyEn.join(', ')}`).toEqual([]);
    expect(onlyZh, `only in zh: ${onlyZh.join(', ')}`).toEqual([]);
  });

  it('exposes the Tests tab and its view container', async () => {
    const html = await readFile(htmlPath, 'utf8');
    expect(html).toContain('data-tab="tests"');
    expect(html).toContain('id="view-tests"');
    expect(html).toContain("['board','bugs','tests','docs','admin']");
  });
});
