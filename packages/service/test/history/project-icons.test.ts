import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ICON_RECHECK_MS,
  MAX_ICON_BYTES,
  ProjectIcons,
  findProjectIcon,
  linkIconHrefs,
  sniffImage,
} from '../../src/history/project-icons.js';

const dirs: string[] = [];
/**
 * A fresh project folder, as its real path: on Windows runners `tmpdir()` can
 * be an 8.3 short name (`RUNNER~1`) while the icon search reports real paths.
 */
const tmp = (): string => {
  const d = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'threadgarden-icons-')));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, body: string | Buffer = ''): string => {
  const p = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A PNG-signed buffer; `tag` makes each fixture's bytes (and data URL) distinct. */
const png = (tag = 'x'): Buffer => Buffer.concat([Buffer.from(PNG_SIG), Buffer.from(tag)]);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([4, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>';

const dataUrl = (mime: string, body: string | Buffer): string =>
  `data:${mime};base64,${Buffer.from(body).toString('base64')}`;

/** Which project file the icon came from, relative to `root`, with forward slashes. */
const found = async (root: string): Promise<string | null> => {
  const icon = await findProjectIcon(root);
  if (!icon) return null;
  return path.relative(root, icon.file).split(path.sep).join('/');
};

/** Whether this machine lets the test create symlinks and read through them. */
const symlinksWork = ((): boolean => {
  const d = mkdtempSync(path.join(tmpdir(), 'threadgarden-icons-link-'));
  try {
    writeFileSync(path.join(d, 'a'), 'a');
    symlinkSync(path.join(d, 'a'), path.join(d, 'b'));
    return readFileSync(path.join(d, 'b'), 'utf8') === 'a';
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();

describe('sniffImage', () => {
  it('recognises the allowed image types by their bytes', () => {
    expect(sniffImage(png())).toBe('image/png');
    expect(sniffImage(ICO)).toBe('image/x-icon');
    expect(sniffImage(JPG)).toBe('image/jpeg');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(Buffer.from('GIF87a\x01\x00', 'latin1'))).toBe('image/gif');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(Buffer.from(SVG))).toBe('image/svg+xml');
  });

  it('accepts SVG after a BOM, whitespace or an XML declaration', () => {
    expect(sniffImage(Buffer.from(`\uFEFF\n  ${SVG}`))).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from(`<?xml version="1.0"?>\n${SVG}`))).toBe('image/svg+xml');
  });

  it('rejects everything else', () => {
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(Buffer.from('hello world'))).toBeNull();
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><note/>'))).toBeNull();
    expect(sniffImage(Buffer.from('<html><svg></svg></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('BM\x00\x00', 'latin1'))).toBeNull();
    expect(sniffImage(Buffer.from('RIFF\x00\x00\x00\x00WAVE', 'latin1'))).toBeNull();
  });
});

describe('linkIconHrefs', () => {
  it('lists icon links before apple-touch-icon ones, each in document order', () => {
    const html = `<!doctype html><html><head>
      <link rel="apple-touch-icon" href="/apple.png">
      <link href="/a.svg" rel="icon" type="image/svg+xml" />
      <link rel='shortcut icon' href='/b.ico'>
      <LINK REL=ICON HREF=/c.png>
      <link rel="stylesheet" href="/app.css">
      <link rel="manifest" href="/site.webmanifest">
      <link rel="mask-icon" href="/mask.svg" color="#000">
    </head></html>`;
    expect(linkIconHrefs(html)).toEqual(['/a.svg', '/b.ico', '/c.png', '/apple.png']);
  });

  it('ignores commented-out links and links without href', () => {
    const html =
      '<!-- <link rel="icon" href="/old.png"> --><link rel="icon"><link rel="icon" href="/new.png">';
    expect(linkIconHrefs(html)).toEqual(['/new.png']);
  });
});

describe('findProjectIcon', () => {
  it('answers null for a folder without an icon and for a missing folder', async () => {
    const root = tmp();
    put(root, 'README.md', '# hi');
    expect(await findProjectIcon(root)).toBeNull();
    expect(await findProjectIcon(path.join(root, 'gone'))).toBeNull();
  });

  it('returns the file as a data URL typed by its bytes', async () => {
    const root = tmp();
    put(root, 'favicon.ico', ICO);
    const icon = await findProjectIcon(root);
    expect(icon?.dataUrl).toBe(dataUrl('image/x-icon', ICO));
    expect(icon?.size).toBe(ICO.length);
    // A favicon.ico that really is a PNG is common: the bytes decide the type.
    put(root, 'favicon.ico', png());
    expect((await findProjectIcon(root))?.dataUrl).toBe(dataUrl('image/png', png()));
  });

  it('prefers an icon linked from index.html, resolved against public/', async () => {
    const root = tmp();
    put(root, 'favicon.ico', ICO);
    put(root, 'index.html', '<link rel="icon" type="image/svg+xml" href="/brand.svg">');
    put(root, 'public/brand.svg', SVG);
    expect(await found(root)).toBe('public/brand.svg');
  });

  it('resolves a relative href against the html file', async () => {
    const root = tmp();
    put(root, 'src/index.html', '<link rel="icon" href="./assets/i.png?v=2#x">');
    put(root, 'src/assets/i.png', png());
    expect(await found(root)).toBe('src/assets/i.png');
  });

  it("resolves SvelteKit's %sveltekit.assets% against static/", async () => {
    const root = tmp();
    put(root, 'src/app.html', '<link rel="icon" href="%sveltekit.assets%/favicon.png" />');
    put(root, 'static/favicon.png', png());
    expect(await found(root)).toBe('static/favicon.png');
  });

  it('checks index.html before public/index.html', async () => {
    const root = tmp();
    put(root, 'public/index.html', '<link rel="icon" href="%PUBLIC_URL%/late.png">');
    put(root, 'public/late.png', png('late'));
    put(root, 'index.html', '<link rel="icon" href="/early.png">');
    put(root, 'public/early.png', png('early'));
    expect(await found(root)).toBe('public/early.png');
  });

  it('skips remote, data and escaping hrefs and links that are not images', async () => {
    const outside = tmp();
    put(outside, 'x.png', png());
    const root = tmp();
    const rel = path.relative(root, path.join(outside, 'x.png')).split(path.sep).join('/');
    put(
      root,
      'index.html',
      [
        '<link rel="icon" href="https://example.com/favicon.ico">',
        '<link rel="icon" href="//cdn.example.com/f.png">',
        '<link rel="icon" href="data:image/png;base64,AAAA">',
        `<link rel="icon" href="${rel}">`,
        '<link rel="icon" href="/notes.txt">',
        '<link rel="icon" href="/fake.png">',
      ].join('\n'),
    );
    put(root, 'public/notes.txt', 'not an image');
    put(root, 'public/fake.png', 'not a png');
    put(root, 'favicon.svg', SVG);
    expect(await found(root)).toBe('favicon.svg');
  });

  it('walks the fixed paths in order', async () => {
    const root = tmp();
    put(root, '.github/logo.png', png('github'));
    expect(await found(root)).toBe('.github/logo.png');
    put(root, 'src-tauri/icons/icon.png', png('tauri'));
    expect(await found(root)).toBe('src-tauri/icons/icon.png');
    put(root, 'public/logo.webp', WEBP);
    expect(await found(root)).toBe('public/logo.webp');
    put(root, 'logo.svg', SVG);
    expect(await found(root)).toBe('logo.svg');
    put(root, 'icon.png', png('icon'));
    expect(await found(root)).toBe('icon.png');
    put(root, 'assets/icon.gif', GIF);
    expect(await found(root)).toBe('assets/icon.gif');
    put(root, 'src/app/icon.jpg', JPG);
    expect(await found(root)).toBe('src/app/icon.jpg');
    put(root, 'src/app/favicon.ico', ICO);
    expect(await found(root)).toBe('src/app/favicon.ico');
    put(root, 'app/icon.svg', SVG);
    expect(await found(root)).toBe('app/icon.svg');
    put(root, 'app/favicon.ico', ICO);
    expect(await found(root)).toBe('app/favicon.ico');
    put(root, 'static/favicon.png', png('static'));
    expect(await found(root)).toBe('static/favicon.png');
    put(root, 'public/favicon.png', png('public'));
    expect(await found(root)).toBe('public/favicon.png');
    put(root, 'favicon.png', png('root'));
    expect(await found(root)).toBe('favicon.png');
    put(root, 'favicon.ico', ICO);
    expect(await found(root)).toBe('favicon.ico');
    put(root, 'favicon.svg', SVG);
    expect(await found(root)).toBe('favicon.svg');
  });

  it('looks one level into apps/* and packages/* after the root, apps first', async () => {
    const root = tmp();
    put(root, 'packages/ui/logo.svg', SVG);
    expect(await found(root)).toBe('packages/ui/logo.svg');
    put(root, 'apps/web/public/favicon.svg', SVG);
    expect(await found(root)).toBe('apps/web/public/favicon.svg');
    put(root, 'apps/admin/favicon.ico', ICO);
    expect(await found(root)).toBe('apps/admin/favicon.ico');
    put(root, '.github/logo.png', png());
    expect(await found(root)).toBe('.github/logo.png');
    // Never deeper than one level.
    const deep = tmp();
    put(deep, 'apps/web/nested/favicon.ico', ICO);
    expect(await found(deep)).toBeNull();
  });

  it('refuses files over the size cap', async () => {
    const root = tmp();
    const big = Buffer.concat([png(), Buffer.alloc(MAX_ICON_BYTES + 1 - png().length)]);
    put(root, 'favicon.png', big);
    expect(await findProjectIcon(root)).toBeNull();
    put(root, 'logo.svg', SVG);
    expect(await found(root)).toBe('logo.svg');
    put(root, 'favicon.png', big.subarray(0, MAX_ICON_BYTES));
    expect(await found(root)).toBe('favicon.png');
  });

  it('refuses files whose bytes do not match an allowed image type', async () => {
    const root = tmp();
    put(root, 'favicon.png', 'GIF? no, text');
    put(root, 'favicon.ico', '<svg></svg>');
    put(root, 'logo.svg', '<html><body>hi</body></html>');
    put(root, 'favicon.bmp', 'BM\x00\x00');
    expect(await findProjectIcon(root)).toBeNull();
    put(root, 'public/logo.gif', GIF);
    expect(await found(root)).toBe('public/logo.gif');
  });

  it('refuses directories and empty files', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'favicon.ico'));
    put(root, 'favicon.png', '');
    expect(await findProjectIcon(root)).toBeNull();
  });

  it.skipIf(!symlinksWork)('refuses icons that are symlinks out of the project', async () => {
    const outside = tmp();
    put(outside, 'secret.png', png('secret'));
    mkdirSync(path.join(outside, 'pub'));
    put(outside, 'pub/favicon.png', png('pub'));
    const root = tmp();
    symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'favicon.png'));
    symlinkSync(
      path.join(outside, 'pub'),
      path.join(root, 'public'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    put(root, 'index.html', '<link rel="icon" href="/favicon.png">');
    expect(await findProjectIcon(root)).toBeNull();
  });

  it.skipIf(!symlinksWork)('follows symlinks that stay inside the project', async () => {
    const root = tmp();
    put(root, 'brand/mark.png', png('mark'));
    symlinkSync(path.join(root, 'brand', 'mark.png'), path.join(root, 'favicon.png'));
    const icon = await findProjectIcon(root);
    expect(icon?.dataUrl).toBe(dataUrl('image/png', png('mark')));
  });

  it('stops after a bounded number of file-system calls', async () => {
    const root = tmp();
    for (let i = 0; i < 40; i++)
      mkdirSync(path.join(root, 'apps', `a${String(i).padStart(2, '0')}`), { recursive: true });
    put(root, 'packages/z/favicon.ico', ICO);
    expect(await found(root)).toBe('packages/z/favicon.ico');
    expect(await findProjectIcon(root, { maxOps: 10 })).toBeNull();
  });
});

describe('ProjectIcons', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('caches per project and re-reads when the file mtime changes', async () => {
    const root = tmp();
    const file = put(root, 'favicon.png', png('one'));
    // Whole milliseconds, so setting the same mtime again is exact.
    const mtime = new Date(1_700_000_000_000);
    utimesSync(file, mtime, mtime);
    const c = clock();
    let finds = 0;
    const icons = new ProjectIcons({
      now: c.now,
      find: (r) => {
        finds++;
        return findProjectIcon(r);
      },
    });
    expect(await icons.get('p', root)).toBe(dataUrl('image/png', png('one')));
    // Same size and mtime: the cached answer stands, nothing is searched again.
    writeFileSync(file, png('two'));
    utimesSync(file, mtime, mtime);
    expect(await icons.get('p', root)).toBe(dataUrl('image/png', png('one')));
    expect(finds).toBe(1);
    // A new mtime: read again.
    utimesSync(file, mtime, new Date(mtime.getTime() + 5_000));
    expect(await icons.get('p', root)).toBe(dataUrl('image/png', png('two')));
    expect(finds).toBe(2);
  });

  it('searches again after ICON_RECHECK_MS, also after a null answer', async () => {
    const root = tmp();
    const c = clock();
    const icons = new ProjectIcons({ now: c.now });
    expect(await icons.get('p', root)).toBeNull();
    put(root, 'logo.svg', SVG);
    expect(await icons.get('p', root)).toBeNull();
    c.advance(ICON_RECHECK_MS);
    expect(await icons.get('p', root)).toBe(dataUrl('image/svg+xml', SVG));
    // A better icon added later is found at the next recheck.
    put(root, 'favicon.ico', ICO);
    expect(await icons.get('p', root)).toBe(dataUrl('image/svg+xml', SVG));
    c.advance(ICON_RECHECK_MS);
    expect(await icons.get('p', root)).toBe(dataUrl('image/x-icon', ICO));
  });

  it('searches again at once when the cached file is gone', async () => {
    const root = tmp();
    const file = put(root, 'favicon.ico', ICO);
    put(root, 'logo.svg', SVG);
    const icons = new ProjectIcons({ now: clock().now });
    expect(await icons.get('p', root)).toBe(dataUrl('image/x-icon', ICO));
    rmSync(file);
    expect(await icons.get('p', root)).toBe(dataUrl('image/svg+xml', SVG));
  });

  it('joins a search already in flight for the same project', async () => {
    const root = tmp();
    put(root, 'favicon.ico', ICO);
    let finds = 0;
    const icons = new ProjectIcons({
      find: (r) => {
        finds++;
        return findProjectIcon(r);
      },
    });
    const [a, b, c] = await Promise.all([
      icons.get('p', root),
      icons.get('p', root),
      icons.get('p', root),
    ]);
    expect(finds).toBe(1);
    expect(a).toBe(dataUrl('image/x-icon', ICO));
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('runs at most maxConcurrent searches at once', async () => {
    let running = 0;
    let peak = 0;
    const icons = new ProjectIcons({
      maxConcurrent: 2,
      find: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return null;
      },
    });
    const all = Array.from({ length: 8 }, (_, i) => icons.get(`p${i}`, `/nowhere/${i}`));
    expect(await Promise.all(all)).toEqual(Array(8).fill(null));
    expect(peak).toBe(2);
  });

  it('answers null when the search fails', async () => {
    const icons = new ProjectIcons({
      find: () => Promise.reject(new Error('boom')),
    });
    expect(await icons.get('p', '/x')).toBeNull();
  });

  it('forgets the cached icon when the project path changes', async () => {
    const a = tmp();
    const b = tmp();
    put(a, 'favicon.ico', ICO);
    put(b, 'logo.svg', SVG);
    const icons = new ProjectIcons({ now: clock().now });
    expect(await icons.get('p', a)).toBe(dataUrl('image/x-icon', ICO));
    expect(await icons.get('p', b)).toBe(dataUrl('image/svg+xml', SVG));
  });
});
