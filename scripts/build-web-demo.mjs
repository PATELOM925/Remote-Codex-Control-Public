#!/usr/bin/env node
// Builds the static public demo of the web console into dist-demo/ (or the
// directory given as the first argument). Each HTML edit must match exactly once.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'apps/web');
const outDir = path.resolve(process.argv[2] || path.join(root, 'dist-demo'));

if (outDir === root || root.startsWith(`${outDir}${path.sep}`)) {
  throw new Error(`build-web-demo: refusing to write to ${outDir}`);
}

const CSP = [
  "default-src 'self'",
  "connect-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

const HEADERS = [
  '/*',
  `  Content-Security-Policy: ${CSP}`,
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '  X-Frame-Options: DENY',
  '',
].join('\n');

const DEMO_CONFIG = '// Turns on the simulated Mac. Only the public demo build includes this file.\nwindow.RCC_DEMO = true;\n';

const DEMO_BANNER = `<div class="demo-banner" role="status">
    <p><strong>Demo mode.</strong> This page uses made-up data and does not connect to any computer. <a href="https://github.com/PATELOM925/Remote-Codex-Control-Public" target="_blank" rel="noreferrer">Get the real install from GitHub</a>.</p>
    <button id="demoResetButton" class="small secondary" type="button">Reset demo</button>
  </div>
  <main class="demo-page">`;

const replaceOnce = (html, pattern, replacement) => {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const count = [...html.matchAll(new RegExp(pattern.source, flags))].length;
  if (count !== 1) {
    throw new Error(`build-web-demo: expected one match for ${pattern}, found ${count}`);
  }
  return html.replace(pattern, replacement);
};

const demoHtml = (html) => {
  let out = html;
  out = replaceOnce(out, /<title>RCC Web Console<\/title>/, '<title>RCC Web Console demo</title>');
  out = replaceOnce(out, /<main>/, () => DEMO_BANNER);
  out = replaceOnce(out, /\s*<a href="#quick-setup" data-section-link="quick-setup">Setup<\/a>/, '');
  out = replaceOnce(out, /<section class="notice landing-section">[\s\S]*?<\/section>/, () => (
    '<section class="notice landing-section"><strong>Demo only.</strong> Projects, threads, approvals and replies are made up. Changes reset when you reload the page.</section>'
  ));
  out = replaceOnce(out, /<section id="quick-setup"[\s\S]*?<\/section>\s*/, '');
  out = replaceOnce(out, /<p class="lead">[\s\S]*?<\/p>/, () => (
    '<p class="lead">Try the console with made-up projects, threads and approvals. Approving, sending and interrupting stay in this browser.</p>'
  ));
  out = replaceOnce(out, /<div class="actions">[\s\S]*?<\/div>/, () => (
    '<div class="actions"><a class="button" href="#connect" data-section-link="connect">Open the demo</a></div>'
  ));
  out = replaceOnce(out, /<h2>Connect to RCC<\/h2>/, '<h2>Demo Mac (simulated)</h2>');
  out = replaceOnce(out, /<p class="eyebrow">Connect first<\/p>/, '<p class="eyebrow">Start here</p>');
  out = replaceOnce(out, /<p class="eyebrow">Quick Web Setup<\/p>/, '<p class="eyebrow">Setup</p>');
  out = replaceOnce(out, /Connect first to load projects and threads\./, 'Open the demo console to load projects and threads.');
  out = replaceOnce(out, /<p class="muted">Away from your Mac\?[\s\S]*?<\/p>/, () => (
    '<p class="muted">This demo uses a simulated Mac. Nothing you do is sent from your browser, and no computer is needed.</p>'
  ));
  out = replaceOnce(out, /<button id="connectButton" type="submit">Connect to RCC<\/button>/, '<button id="connectButton" type="submit">Open demo console</button>');
  out = replaceOnce(out, /<fieldset class="mode-picker"[\s\S]*?<\/fieldset>\s*/, '');
  out = replaceOnce(out, /<p id="modeHelp"[^>]*>[\s\S]*?<\/p>\s*/, '');
  out = replaceOnce(out, /<div id="relayFields"[\s\S]*?<\/div>\s*/, '');
  out = replaceOnce(out, /<div id="localFields"[\s\S]*?<\/div>\s*/, '');
  out = replaceOnce(out, /\s*<article>\s*<h2>Remote Relay<\/h2>[\s\S]*?<\/article>/, '');
  out = replaceOnce(out, /\s*<article>\s*<h2>Local API<\/h2>[\s\S]*?<\/article>/, '');
  out = replaceOnce(out, /\s*<a class="button ghost small-link" href="#connect">Change connection<\/a>/, '');
  out = replaceOnce(out, /<h2>One Mac command, then connect from phone\.<\/h2>/, '<h2>Setup is not part of the demo.</h2>');
  out = replaceOnce(out, /(<section id="setupSection"[\s\S]*?)<ol>[\s\S]*?<\/ol>/, (match, head) => (
    `${head}<p class="muted">The demo has no Mac to set up. The install steps are in the GitHub repo linked at the top of the page.</p>`
  ));
  out = replaceOnce(out, /<input id="attachmentInput" type="file" multiple \/>/, '<input id="attachmentInput" type="file" multiple disabled />');
  out = replaceOnce(out, /<div id="attachmentsPreview"([^>]*)>No attachments selected\.<\/div>/, (match, attrs) => (
    `<div id="attachmentsPreview"${attrs}>File upload is not available in the demo.</div>`
  ));
  out = replaceOnce(out, /<script src="\.\/app\.js\?v=[^"]*"><\/script>/, (match) => (
    `<script src="./demo-config.js"></script>\n  <script src="./demo-relay.js"></script>\n  ${match}`
  ));

  if (/id="(localToken|relayToken|localBaseUrl|relayBaseUrl)"/.test(out)) {
    throw new Error('build-web-demo: token or base URL fields are still in the demo HTML');
  }
  if (/rcc-magnus-alpha|vercel\.app/.test(out)) {
    throw new Error('build-web-demo: hosted relay hostname is still in the demo HTML');
  }
  return out;
};

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'index.html'), demoHtml(fs.readFileSync(path.join(webDir, 'index.html'), 'utf8')));
for (const file of ['app.js', 'demo-relay.js', 'styles.css', 'manifest.webmanifest']) {
  fs.copyFileSync(path.join(webDir, file), path.join(outDir, file));
}
fs.writeFileSync(path.join(outDir, 'demo-config.js'), DEMO_CONFIG);
fs.writeFileSync(path.join(outDir, '_headers'), HEADERS);

console.log(`[web:demo:build] wrote ${fs.readdirSync(outDir).sort().join(', ')} to ${path.relative(root, outDir) || '.'}`);
