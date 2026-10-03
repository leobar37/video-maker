import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { constants } from 'node:fs';
import fs, { mkdir, mkdtemp, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReviewPreviewHandler, type ReviewPreviewFile } from './review-preview';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vm-review-'));
  roots.push(root);
  await mkdir(path.join(root, 'final'));
  const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50, 1, 2, 3, 4, 5, 6, 7, 8]);
  await writeFile(path.join(root, 'final', 'sample.mp4'), bytes);
  const files: ReviewPreviewFile[] = [
    { route: '/review/index.html', path: 'final/index.html', mediaType: 'text/html' },
    { route: '/review/sample.mp4', path: 'final/sample.mp4', mediaType: 'video/mp4' },
  ];
  return { root, bytes, files, handler: createReviewPreviewHandler({ rootDir: root, files }) };
}

function request(route: string, headers: HeadersInit = {}, method = 'GET'): Request {
  return new Request(`http://preview.internal${route}`, { method, headers });
}

describe('explicit read-only final review preview (no listener)', () => {
  test('HTML refresh uses complete UTF-8 bytes for both different sizes and HEAD', async () => {
    const { root, handler } = await fixture();
    for (const html of ['<!doctype html><p>á</p>', '<!doctype html><p>Vídeo 😀 actualizado y mucho más largo</p>']) {
      await writeFile(path.join(root, 'final', 'index.html'), html);
      const response = await handler(request('/review/index.html'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe(String(new TextEncoder().encode(html).length));
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(html);
      const head = await handler(request('/review/index.html', { range: 'bytes=1-2' }, 'HEAD'));
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String(new TextEncoder().encode(html).length));
      expect(await head.text()).toBe('');
    }
  });

  test('review HTML permits only declared canonical HTML links and removes navigation side channels', async () => {
    const { root, files, handler } = await fixture();
    // A later caller mutation must not expand the navigation whitelist.
    files.push({ route: '/review/undeclared.html', path: 'final/undeclared.html', mediaType: 'text/html' });
    const hostileHrefs = [
      'https://attacker.example/leak', '//attacker.example/leak', 'data:text/html,%3Cp%3Eleak',
      'javascript:alert(1)', 'mailto:leak@attacker.example', 'https://user:pass@attacker.example/leak',
      '/api/catalog', '/review/undeclared.html', 'sample.mp4', '../api/catalog',
      '/review/sample.mp4?leak=1', '/review/sample.mp4#outside', '/review/%73ample.mp4',
      ' https://attacker.example/leak', 'https:&#47;&#47;attacker.example/leak',
    ];
    const html = `<!doctype html><html><head>
      <base href="https://attacker.example/" target="_self">
      <meta HTTP-EQUIV="REFRESH" content="0;url=https://attacker.example/leak">
      <meta http-equiv="ref&#114;esh" content="0;url=https://attacker.example/leak">
      <noscript><meta http-equiv="refresh" content="0;url=https://attacker.example/head"></noscript>
      <meta charset="utf-8"><style>p { color: red }</style></head><body>
      <p style="color:blue">Texto á 😀</p>
      ${hostileHrefs.map((href) => `<a href="${href}" target="_self" ping="https://attacker.example/ping">Fuera</a>`).join('')}
      <A HREF="https://attacker.example/case" TARGET="_self">Mayúsculas</A>
      <a href="/review/sample.mp4" target="_blank" ping="https://attacker.example/ping" attributionsrc="https://attacker.example/attr">Vídeo local</a>
      <a href="/review/index.html">Página local</a>
      <map><area href="https://attacker.example/area" target="_self"><area href="/review/sample.mp4" target="_self" formtarget="_blank"></map>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:base="https://attacker.example/">
        <a href="/review/sample.mp4" xlink:href="https://attacker.example/svg"><text>Texto SVG</text><set attributeName="href" to="https://attacker.example/animated"/></a>
        <image href="https://attacker.example/image" xlink:href="https://attacker.example/xlink"/>
      </svg>
      <math><mtext href="https://attacker.example/math">Texto MathML</mtext></math>
      <noscript><a href="https://attacker.example/noscript" target="_self">Oculto</a></noscript>
      <img src="data:image/png;base64,AA=="><video src="/review/sample.mp4"></video>
      </body></html>`;
    await writeFile(path.join(root, 'final', 'index.html'), html);
    const response = await handler(request('/review/index.html'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('content-security-policy')).not.toContain('navigate-to');
    const sanitized = await response.text();
    const elements: { tag: string; namespace: string; attributes: Record<string, string> }[] = [];
    await new HTMLRewriter().on('*', {
      element(element) {
        elements.push({
          tag: element.tagName.toLowerCase(), namespace: element.namespaceURI,
          attributes: Object.fromEntries([...element.attributes].map(([name, value]) => [name.toLowerCase(), value])),
        });
      },
    }).transform(new Response(sanitized)).arrayBuffer();
    expect(elements.filter((element) => element.tag === 'base')).toHaveLength(0);
    expect(elements.filter((element) => element.tag === 'meta' && 'http-equiv' in element.attributes)).toHaveLength(0);
    expect(elements.filter((element) => element.tag === 'noscript')).toHaveLength(0);
    const links = elements.filter((element) => 'href' in element.attributes);
    expect(links.map((element) => [element.tag, element.attributes.href])).toEqual([
      ['a', '/review/sample.mp4'], ['a', '/review/index.html'], ['area', '/review/sample.mp4'],
    ]);
    expect(links.every((element) => element.namespace === 'http://www.w3.org/1999/xhtml')).toBe(true);
    for (const element of elements) {
      for (const attribute of ['xlink:href', 'xml:base', 'ping', 'target', 'formtarget', 'attributionsrc']) {
        expect(element.attributes[attribute]).toBeUndefined();
      }
      if (element.namespace !== 'http://www.w3.org/1999/xhtml') expect(element.tag).not.toBe('a');
    }
    expect(sanitized).toContain('Texto á 😀');
    expect(sanitized).toContain('Texto SVG');
    expect(sanitized).toContain('Texto MathML');
    expect(sanitized).toContain('<style>p { color: red }</style>');
    expect(elements.find((element) => element.tag === 'p')?.attributes.style).toBe('color:blue');
    expect(elements.find((element) => element.tag === 'img')?.attributes.src).toBe('data:image/png;base64,AA==');
    expect(elements.find((element) => element.tag === 'video')?.attributes.src).toBe('/review/sample.mp4');
    expect(response.headers.get('content-length')).toBe(String(new TextEncoder().encode(sanitized).byteLength));
  });

  test('fresh sanitized UTF-8 snapshots set full GET and HEAD length after navigation removal', async () => {
    const { root, handler } = await fixture();
    for (const text of ['á', 'Vídeo 😀 actualizado y mucho más largo']) {
      const html = `<!doctype html><p>${text}</p><a href="https://attacker.example/leak" target="_self">Fuera</a>`;
      const expected = `<!doctype html><p>${text}</p><a>Fuera</a>`;
      await writeFile(path.join(root, 'final', 'index.html'), html);
      const get = await handler(request('/review/index.html', { range: 'bytes=1-2' }));
      expect(get.status).toBe(200);
      expect(await get.text()).toBe(expected);
      const size = String(new TextEncoder().encode(expected).byteLength);
      expect(size).not.toBe(String(new TextEncoder().encode(html).byteLength));
      expect(get.headers.get('content-length')).toBe(size);
      expect(get.headers.get('content-range')).toBeNull();
      const head = await handler(request('/review/index.html', { range: 'bytes=999-' }, 'HEAD'));
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(size);
      expect(head.headers.get('content-range')).toBeNull();
      expect(await head.text()).toBe('');
    }
  });

  test('HTML parser and asynchronous rewrite failures return redacted 404 without a raw fallback', async () => {
    const { root, handler } = await fixture();
    await writeFile(path.join(root, 'final', 'index.html'), '<p>RAW-CONTENT</p><a href="https://attacker.example">Leak</a>');
    const transform = spyOn(HTMLRewriter.prototype, 'transform').mockImplementation(() => {
      throw new Error(`PRIVATE-CONTENT ${root}`);
    });
    try {
      for (const method of ['GET', 'HEAD']) {
        const response = await handler(request('/review/index.html', {}, method));
        expect(response.status).toBe(404);
        expect(await response.text()).toBe(method === 'HEAD' ? '' : 'Not found.\n');
      }
    } finally {
      transform.mockRestore();
    }
    const realOn = HTMLRewriter.prototype.on;
    const on = spyOn(HTMLRewriter.prototype, 'on').mockImplementation(function (this: HTMLRewriter, selector, handlers) {
      return realOn.call(this, selector, {
        ...handlers,
        element() { throw new Error(`PRIVATE-CONTENT ${root}`); },
      });
    });
    try {
      const response = await handler(request('/review/index.html'));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found.\n');
    } finally {
      on.mockRestore();
    }
  });

  test('video bytes and representation size are reread rather than cached', async () => {
    const { root, bytes, handler } = await fixture();
    for (const current of [bytes, new Uint8Array([...bytes, 9, 10, 11, 12, 13])]) {
      await writeFile(path.join(root, 'final', 'sample.mp4'), current);
      const full = await handler(request('/review/sample.mp4'));
      expect(full.status).toBe(200);
      expect(full.headers.get('content-length')).toBe(String(current.length));
      expect(new Uint8Array(await full.arrayBuffer())).toEqual(current);
      const suffix = await handler(request('/review/sample.mp4', { range: 'bytes=-3' }));
      expect(suffix.headers.get('content-range')).toBe(`bytes ${current.length - 3}-${current.length - 1}/${current.length}`);
      expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(current.slice(-3));
    }
  });

  test('GET video serves exact single bounded, open and suffix ranges', async () => {
    const { bytes, handler } = await fixture();
    for (const [range, start, end] of [
      ['bytes=2-5', 2, 5], ['bytes=12-', 12, 19], ['bytes=-4', 16, 19],
      ['bytes=18-999', 18, 19], ['bytes=-999', 0, 19],
    ] as const) {
      const response = await handler(request('/review/sample.mp4', { range }));
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${bytes.length}`);
      expect(response.headers.get('content-length')).toBe(String(end - start + 1));
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(start, end + 1));
    }
  });

  test('HEAD ignores even malformed Range, and If-Range conservatively returns full GET', async () => {
    const { bytes, handler } = await fixture();
    for (const range of ['bytes=2-5', 'bytes=999-', 'bytes=1-2,4-6']) {
      const head = await handler(request('/review/sample.mp4', { range }, 'HEAD'));
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String(bytes.length));
      expect(head.headers.get('accept-ranges')).toBe('bytes');
      expect(head.headers.get('content-range')).toBeNull();
      expect(await head.text()).toBe('');
    }
    for (const validator of ['"not-a-current-etag"', 'Sat, 03 Oct 2026 12:00:00 GMT']) {
      const full = await handler(request('/review/sample.mp4', { range: 'bytes=2-5', 'if-range': validator }));
      expect(full.status).toBe(200);
      expect(full.headers.get('content-range')).toBeNull();
      expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    }
  });

  test('malformed, multiple, unsafe integer, empty and unsatisfiable ranges return empty 416', async () => {
    const { root, bytes, handler } = await fixture();
    for (const range of ['bytes=20-', 'bytes=9-3', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-6', 'items=1-2', 'bytes=foo-bar', 'bytes=9007199254740992-', 'bytes=1-9007199254740992']) {
      const response = await handler(request('/review/sample.mp4', { range }));
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe(`bytes */${bytes.length}`);
      expect(response.headers.get('content-length')).toBe('0');
      expect(await response.text()).toBe('');
    }
    await writeFile(path.join(root, 'final', 'sample.mp4'), new Uint8Array());
    const empty = await handler(request('/review/sample.mp4', { range: 'bytes=0-' }));
    expect(empty.status).toBe(416);
    expect(empty.headers.get('content-range')).toBe('bytes */0');
  });

  test('private/source/original/transcript/journal/intent/credential and hidden declarations remain 404', async () => {
    const { root } = await fixture();
    const paths = ['source.mp4', 'original.mp4', 'transcript.html', 'journal.html', 'journals/final.html', 'intent.html', 'credentials.html', '.hidden.html', 'private/final.html', 'src/final.html', 'final/private.txt', '../escape.html'];
    const files = paths.map((file, index): ReviewPreviewFile => ({ route: `/review/file-${index}${file.endsWith('.mp4') ? '.mp4' : '.html'}`, path: file, mediaType: file.endsWith('.mp4') ? 'video/mp4' : 'text/html' }));
    const handler = createReviewPreviewHandler({ rootDir: root, files });
    for (const [index, file] of paths.entries()) {
      if (!file.includes('/')) await writeFile(path.join(root, file), 'PRIVATE-CONTENT');
      const response = await handler(request(files[index]!.route));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('PRIVATE-CONTENT');
    }
  });

  test('undeclared files, directories, traversal, encoded aliases and symlink components never resolve', async () => {
    const { root, files } = await fixture();
    await writeFile(path.join(root, 'final', 'index.html'), '<p>Final</p>');
    await writeFile(path.join(root, 'final', 'undeclared.html'), 'PRIVATE-CONTENT');
    await symlink(path.join(root, 'final', 'index.html'), path.join(root, 'final', 'link.html'));
    await symlink(path.join(root, 'final'), path.join(root, 'linked'));
    files.push(
      { route: '/review/link.html', path: 'final/link.html', mediaType: 'text/html' },
      { route: '/review/linked.html', path: 'linked/index.html', mediaType: 'text/html' },
      { route: '/review/directory.html', path: 'final', mediaType: 'text/html' },
    );
    const handler = createReviewPreviewHandler({ rootDir: root, files });
    for (const route of ['/review', '/review/', '/review/final/', '/review/undeclared.html', '/review/link.html', '/review/linked.html', '/review/directory.html', '/review/%69ndex.html', '/review/%2e%2e/private.html', '/review/%252e%252e%2findex.html', '/review/final%2findex.html', '/review/%5cindex.html', '/review//index.html', '/review/%', '/review/index.html/']) {
      const response = await handler(request(route));
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toBe('Not found.\n');
      expect(body).not.toContain(root);
    }
    const linkRoot = path.join(root, 'alias');
    await symlink(path.join(root, 'final'), linkRoot);
    const linkedRootHandler = createReviewPreviewHandler({ rootDir: linkRoot, files: [{ route: '/review/index.html', path: 'index.html', mediaType: 'text/html' }] });
    expect((await linkedRootHandler(request('/review/index.html'))).status).toBe(404);
  });

  test('ancestor replacement between validation and open fails closed while descriptors remain pinned', async () => {
    for (const scenario of ['before-parent-open', 'before-file-open', 'root-before-file-open']) {
      const { root, handler } = await fixture();
      await writeFile(path.join(root, 'final', 'index.html'), '<p>Declared final</p>');
      const declared = await fs.stat(path.join(root, 'final', 'index.html'), { bigint: true });
      const foreignRoot = await mkdtemp(path.join(os.tmpdir(), 'vm-foreign-'));
      roots.push(foreignRoot);
      const foreign = path.join(foreignRoot, 'private');
      await mkdir(path.join(foreign, 'final'), { recursive: true });
      await writeFile(path.join(foreign, 'index.html'), 'PRIVATE-CONTENT');
      await writeFile(path.join(foreign, 'final', 'index.html'), 'PRIVATE-CONTENT');
      const replaceRoot = scenario === 'root-before-file-open';
      const replaced = replaceRoot ? root : path.join(root, 'final');
      const retained = replaceRoot ? `${root}-retained` : path.join(root, 'retained');
      if (replaceRoot) roots.push(retained);
      const opened: FileHandle[] = [];
      const openedFlags: { path: string; flags: unknown }[] = [];
      const realOpen = fs.open;
      let swapped = false;
      let finalPath: string | undefined;
      let finalInode: bigint | undefined;
      const open = spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
        const name = String(filename);
        const trigger = scenario === 'before-parent-open' ? name.endsWith('/final') : name.endsWith('/index.html');
        if (!swapped && trigger) {
          swapped = true;
          await rename(replaced, retained);
          await symlink(foreign, replaced);
        }
        const handle = await realOpen(filename, flags, mode);
        opened.push(handle);
        openedFlags.push({ path: name, flags });
        if (name.endsWith('/index.html')) {
          finalPath = name;
          finalInode = (await handle.stat({ bigint: true })).ino;
        }
        return handle;
      });
      try {
        const response = await handler(request('/review/index.html'));
        expect(swapped).toBe(true);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('Not found.\n');
        if (scenario !== 'before-parent-open') {
          // The post-swap open still reaches the declared inode, not the foreign
          // symlink target; the later ancestry audit nevertheless rejects it.
          expect(finalPath).toMatch(/^\/proc\/self\/fd\/\d+\/index\.html$/);
          expect(finalInode).toBe(declared.ino);
        }
        for (const entry of openedFlags) {
          expect(entry.path === '/' || /^\/proc\/self\/fd\/\d+\//.test(entry.path)).toBe(true);
          expect(typeof entry.flags).toBe('number');
          expect((Number(entry.flags) & constants.O_NOFOLLOW) !== 0).toBe(true);
          expect((Number(entry.flags) & (entry.path.endsWith('/index.html')
            ? constants.O_NONBLOCK : constants.O_DIRECTORY)) !== 0).toBe(true);
        }
        expect(opened.length).toBeGreaterThan(0);
        expect(opened.every((handle) => handle.fd === -1)).toBe(true);
      } finally {
        open.mockRestore();
      }
    }
  });

  test('open errors close every already-pinned directory and redact filesystem details', async () => {
    const { root, handler } = await fixture();
    await writeFile(path.join(root, 'final', 'index.html'), '<p>Final</p>');
    const opened: FileHandle[] = [];
    const realOpen = fs.open;
    const open = spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
      if (String(filename).endsWith('/index.html')) throw new Error(`PRIVATE-CONTENT ${root}`);
      const handle = await realOpen(filename, flags, mode);
      opened.push(handle);
      return handle;
    });
    try {
      const response = await handler(request('/review/index.html'));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found.\n');
      expect(opened.length).toBeGreaterThan(0);
      expect(opened.every((handle) => handle.fd === -1)).toBe(true);
    } finally {
      open.mockRestore();
    }
  });

  test('a final file replaced by a nonregular inode after lstat is rejected before reading', async () => {
    const { root, handler } = await fixture();
    const filename = path.join(root, 'final', 'index.html');
    await writeFile(filename, '<p>Final</p>');
    const realOpen = fs.open;
    const opened: FileHandle[] = [];
    let replaced = false;
    const open = spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      if (!replaced && String(file).endsWith('/index.html')) {
        replaced = true;
        await rm(filename);
        await mkdir(filename);
      }
      const handle = await realOpen(file, flags, mode);
      opened.push(handle);
      return handle;
    });
    try {
      const response = await handler(request('/review/index.html'));
      expect(replaced).toBe(true);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found.\n');
      expect(opened.every((handle) => handle.fd === -1)).toBe(true);
    } finally {
      open.mockRestore();
    }
  });

  test('declared final images are inline byte snapshots and do not apply video Range', async () => {
    const { root, files } = await fixture();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    await writeFile(path.join(root, 'final', 'frame.png'), png);
    files.push({ route: '/review/frame.png', path: 'final/frame.png', mediaType: 'image/png' });
    const handler = createReviewPreviewHandler({ rootDir: root, files });
    const response = await handler(request('/review/frame.png', { range: 'bytes=2-4' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(png.length));
    expect(response.headers.get('accept-ranges')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  test('declarations are copied, route duplicates fail closed, and unsupported types cannot be served', async () => {
    const { root, files, handler } = await fixture();
    await writeFile(path.join(root, 'final', 'index.html'), '<p>Original final</p>');
    const mutable = files[0] as { route: string; path: string; mediaType: string };
    mutable.route = '/review/new.html';
    mutable.path = 'source.html';
    mutable.mediaType = 'video/mp4';
    files.length = 0;
    expect(await (await handler(request('/review/index.html'))).text()).toBe('<p>Original final</p>');
    expect((await handler(request('/review/new.html'))).status).toBe(404);
    const duplicate = createReviewPreviewHandler({ rootDir: root, files: [
      { route: '/review/index.html', path: 'final/index.html', mediaType: 'text/html' },
      { route: '/review/index.html', path: 'final/index.html', mediaType: 'text/html' },
      { route: '/review/code.html', path: 'final/index.html', mediaType: 'application/javascript' as never },
    ] });
    expect((await duplicate(request('/review/index.html'))).status).toBe(404);
    expect((await duplicate(request('/review/code.html'))).status).toBe(404);
    const post = await handler(request('/review/index.html', {}, 'POST'));
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});
