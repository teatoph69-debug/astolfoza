#!/usr/bin/env node
// Builds the whole game into ONE self-contained HTML file: dist/index.html
// (JS, CSS, the training Web Worker and the pretrained brains are all inlined),
// so it can be opened by double-click, hosted anywhere, or played offline.
//
//   node tools/build.mjs            → dist/index.html
//   node tools/build.mjs --serve    → dev server on http://localhost:5173 (rebuilds on reload)

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (...p) => path.join(root, ...p);
const serve = process.argv.includes('--serve');
const minify = !serve && !process.argv.includes('--no-minify');

async function bundle(entry, extra = {}) {
  const res = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    write: false,
    minify,
    target: ['es2020'],
    loader: { '.json': 'json' },
    legalComments: 'none',
    logLevel: 'warning',
    ...extra,
  });
  return res.outputFiles[0].text;
}

export async function build() {
  const t0 = Date.now();
  const workerEntry = r('src/ai/worker.js');
  const workerSrc = fs.existsSync(workerEntry) ? await bundle(workerEntry) : '';
  const js = await bundle(r('src/main.js'), {
    define: { __TRAINER_WORKER_SRC__: JSON.stringify(workerSrc), __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  });
  const cssDir = r('src/ui/styles');
  const cssFiles = fs.readdirSync(cssDir).filter((f) => f.endsWith('.css')).sort((a, b) => (a === 'base.css' ? -1 : b === 'base.css' ? 1 : a.localeCompare(b)));
  let css = cssFiles.map((f) => `/* ${f} */\n` + fs.readFileSync(path.join(cssDir, f), 'utf8')).join('\n');
  if (minify) css = (await esbuild.transform(css, { loader: 'css', minify: true })).code;
  const tpl = fs.readFileSync(r('src/index.html'), 'utf8');
  // Use split/join (not String.replace) so "$" sequences inside the bundle are never interpreted.
  const html = tpl.split('/*__CSS__*/').join(css).split('/*__JS__*/').join(js.replace(/<\/script/gi, '<\\/script'));
  fs.mkdirSync(r('dist'), { recursive: true });
  fs.writeFileSync(r('dist/index.html'), html);
  // Embeddable variant (no <html>/<head>/<body> wrappers) for hosts that provide their own skeleton.
  const inner = (tag) => { const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*)</${tag}>`, 'i').exec(html); return m ? m[1] : ''; };
  const head = inner('head').replace(/<meta charset[^>]*>\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '');
  fs.mkdirSync(r('dist/embed'), { recursive: true });
  fs.writeFileSync(r('dist/embed/muxa-rhythia.html'), head.trim() + '\n' + inner('body').trim() + '\n');
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`built dist/index.html (${kb} KB) in ${Date.now() - t0} ms`);
  return html;
}

if (serve) {
  const port = +(process.env.PORT || 5173);
  http.createServer(async (req, res) => {
    try {
      if (req.url === '/' || req.url.startsWith('/index.html') || req.url.startsWith('/?')) {
        const html = await build();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      } else {
        const file = r(decodeURIComponent(req.url.split('?')[0]));
        if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200);
          fs.createReadStream(file).pipe(res);
        } else {
          res.writeHead(404);
          res.end('not found');
        }
      }
    } catch (e) {
      console.error(e);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(e.stack || e));
    }
  }).listen(port, () => console.log(`dev server: http://localhost:${port}`));
} else {
  await build();
}
