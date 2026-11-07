import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { readPptxMeta } from './pptx.js';
import { parseKv, hfsToPosix } from './adapters/powerpoint-mac.js';
import { parseOsc } from './showcontrol.js';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function slideXml(title: string, opts: { hidden?: boolean; clicks?: number } = {}) {
  const clicks = Array.from({ length: opts.clicks ?? 0 }, (_, i) => `<p:par><p:cTn id="${i + 3}" nodeType="clickEffect"/></p:par>`).join('');
  return `<?xml version="1.0"?><p:sld ${NS}${opts.hidden ? ' show="0"' : ''}><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld><p:timing><p:tnLst>${clicks}</p:tnLst></p:timing></p:sld>`;
}

function notesXml(lines: string[]) {
  const ps = lines.map((l) => (l ? `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>` : '<a:p/>')).join('');
  return `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${ps}</p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`;
}

async function fixture(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', `<p:presentation ${NS}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`);
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`,
  );
  // slide2.xml comes first in the deck order
  zip.file('ppt/slides/slide2.xml', slideXml('Welcome &amp; hello'));
  zip.file(
    'ppt/slides/_rels/slide2.xml.rels',
    `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/></Relationships>`,
  );
  zip.file('ppt/notesSlides/notesSlide2.xml', notesXml(['สวัสดีครับ', '', 'Thank the crew']));
  zip.file('ppt/slides/slide1.xml', slideXml('The problem', { hidden: true, clicks: 3 }));
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<Relationships></Relationships>`);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('readPptxMeta', () => {
  it('reads titles, notes, builds and hidden flags in deck order', async () => {
    const meta = await readPptxMeta(await fixture());
    expect(meta).toEqual([
      { n: 1, title: 'Welcome & hello', notes: 'สวัสดีครับ\n\nThank the crew', builds: 0, hidden: false },
      { n: 2, title: 'The problem', notes: null, builds: 3, hidden: true },
    ]);
  });

  it('rejects files that are not PowerPoint', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    await expect(readPptxMeta(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('Not a PowerPoint file');
  });
});

describe('PowerPoint for Mac helpers', () => {
  it('parses the status lines', () => {
    expect(parseKv('open=1\ninShow=1\nslide=3\nname=a=b.pptx')).toEqual({ open: '1', inShow: '1', slide: '3', name: 'a=b.pptx' });
  });
  it('converts HFS paths', () => {
    expect(hfsToPosix('Macintosh HD:Users:mah:Desktop:deck.pptx')).toBe('/Users/mah/Desktop/deck.pptx');
    expect(hfsToPosix('/Users/mah/deck.pptx')).toBe('/Users/mah/deck.pptx');
  });
});

describe('parseOsc', () => {
  function oscString(s: string) {
    const b = Buffer.from(`${s}\0`, 'utf8');
    const pad = (4 - (b.length % 4)) % 4;
    return Buffer.concat([b, Buffer.alloc(pad)]);
  }
  function msg(address: string, ints: number[] = []) {
    const tags = oscString(`,${'i'.repeat(ints.length)}`);
    const args = ints.map((n) => {
      const b = Buffer.alloc(4);
      b.writeInt32BE(n);
      return b;
    });
    return Buffer.concat([oscString(address), tags, ...args]);
  }

  it('reads an address with int arguments', () => {
    expect(parseOsc(msg('/rsc/goto', [4]))).toEqual([{ address: '/rsc/goto', args: [4] }]);
  });

  it('reads messages inside a bundle', () => {
    const inner = msg('/next');
    const size = Buffer.alloc(4);
    size.writeInt32BE(inner.length);
    const bundle = Buffer.concat([oscString('#bundle'), Buffer.alloc(8), size, inner]);
    expect(parseOsc(bundle)).toEqual([{ address: '/next', args: [] }]);
  });

  it('ignores garbage', () => {
    expect(parseOsc(Buffer.from('nope'))).toEqual([]);
  });
});
