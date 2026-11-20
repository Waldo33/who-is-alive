// Автономный HTML-билд песочницы (один файл): для быстрых превью на телефонах без деплоя.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const fontDir = 'node_modules/@fontsource/press-start-2p/files/';
const face = (subset, range) =>
  `@font-face{font-family:'Press Start 2P';font-style:normal;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${readFileSync(fontDir + `press-start-2p-${subset}-400-normal.woff2`).toString('base64')}) format('woff2');unicode-range:${range}}`;
const fontCss =
  face('cyrillic', 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116') +
  face('latin', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD');

const out = await build({
  entryPoints: ['src/game/standalone.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020', 'safari15'],
  write: false,
  define: { 'process.env.NODE_ENV': '"production"', WEBGL_RENDERER: 'true', CANVAS_RENDERER: 'true' },
  legalComments: 'none',
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#181425">
<title>Массовка — репетиция</title>
<style>${fontCss}
html,body{margin:0;height:100%;background:#181425;color-scheme:dark;touch-action:manipulation;-webkit-text-size-adjust:100%;text-size-adjust:100%}
:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}</style>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%91%BE%3C/text%3E%3C/svg%3E">
</head>
<body>
<div id="app"></div>
<script>${js}</script>
</body>
</html>`;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/sandbox.html', html);
console.log(`dist/sandbox.html — ${(html.length / 1024).toFixed(0)} КБ`);
