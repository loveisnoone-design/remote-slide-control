import JSZip from 'jszip';

export interface PptxSlideMeta {
  n: number;
  title: string | null;
  notes: string | null;
  builds: number;
  hidden: boolean;
}

/**
 * Reads titles, speaker notes, click-build counts and hidden flags straight from
 * a .pptx file. Used on macOS (PowerPoint for Mac does not expose notes reliably
 * to AppleScript) and as a fallback elsewhere.
 */
export async function readPptxMeta(data: Uint8Array | ArrayBuffer): Promise<PptxSlideMeta[]> {
  const zip = await JSZip.loadAsync(data);
  const read = async (path: string) => {
    const f = zip.file(path);
    return f ? f.async('string') : null;
  };

  const presentation = await read('ppt/presentation.xml');
  const presRels = await read('ppt/_rels/presentation.xml.rels');
  if (!presentation || !presRels) throw new Error('Not a PowerPoint file');

  const relTargets = parseRels(presRels);
  const order = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => m[1]!);

  const out: PptxSlideMeta[] = [];
  for (let i = 0; i < order.length; i++) {
    const target = relTargets.get(order[i]!);
    if (!target) continue;
    const slidePath = resolvePath('ppt', target.target);
    const slideXml = (await read(slidePath)) ?? '';
    const slideRels = (await read(relsPathFor(slidePath))) ?? '';
    const notesRel = [...parseRels(slideRels).values()].find((r) => r.type.endsWith('/notesSlide'));
    let notes: string | null = null;
    if (notesRel) {
      const notesXml = await read(resolvePath(dirname(slidePath), notesRel.target));
      if (notesXml) notes = placeholderText(notesXml, ['body']);
    }
    out.push({
      n: i + 1,
      title: placeholderText(slideXml, ['title', 'ctrTitle']),
      notes,
      builds: (slideXml.match(/nodeType="clickEffect"/g) ?? []).length,
      hidden: /<p:sld\b[^>]*\bshow="(0|false)"/.test(slideXml),
    });
  }
  return out;
}

interface Rel {
  target: string;
  type: string;
}

function parseRels(xml: string): Map<string, Rel> {
  const map = new Map<string, Rel>();
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1]!;
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    const type = /\bType="([^"]+)"/.exec(attrs)?.[1] ?? '';
    if (id && target) map.set(id, { target: decodeXml(target), type });
  }
  return map;
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function relsPathFor(p: string): string {
  const dir = dirname(p);
  const base = p.slice(dir.length + 1);
  return `${dir}/_rels/${base}.rels`;
}

function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir ? baseDir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

/** Text of the first shape whose placeholder type is one of `types`, one line per paragraph. */
function placeholderText(xml: string, types: string[]): string | null {
  const shapes = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? [];
  for (const sp of shapes) {
    const ph = /<p:ph\b([^>]*)\/?>/.exec(sp);
    if (!ph) continue;
    const type = /\btype="([^"]+)"/.exec(ph[1]!)?.[1] ?? 'body'; // a placeholder without a type is a body
    if (!types.includes(type)) continue;
    const paragraphs = sp.match(/<a:p\b[^>]*\/>|<a:p\b[\s\S]*?<\/a:p>/g) ?? [];
    const lines = paragraphs.map((p) => {
      let line = '';
      for (const t of p.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)) {
        line += t[1] !== undefined ? decodeXml(t[1]) : '\n';
      }
      return line;
    });
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) return text;
  }
  return null;
}

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}
