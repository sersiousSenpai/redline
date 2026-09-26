// Rebuild the README layout preview from the canonical Markdown.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

const dir = path.dirname(fileURLToPath(import.meta.url));
const md = new MarkdownIt({ html: true });
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const title = tokens[idx + 1].content;
  tokens[idx].attrSet('id', title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-'));
  return self.renderToken(tokens, idx, options);
};
const imageRule = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = tokens[idx].attrGet('src');
  if (!/^https?:/.test(src)) tokens[idx].attrSet('src', '../../../' + src);
  return imageRule(tokens, idx, options, env, self);
};
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href');
  if (href && !/^(?:https?:|#|mailto:)/.test(href)) tokens[idx].attrSet('href', '../../../' + href);
  return self.renderToken(tokens, idx, options);
};
const body = md.render(await readFile(path.resolve(dir, '../../../README.md'), 'utf8'));
const css = `body{margin:0;background:#0d1117;color:#e6edf3;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1012px;margin:35px auto;border:1px solid #30363d;border-radius:7px;padding:32px 40px}h1{font-size:32px}h1,h2{border-bottom:1px solid #30363d;padding-bottom:.3em;line-height:1.25}h2{font-size:24px;margin-top:32px}h3{font-size:20px;margin-top:28px}a{color:#79c0ff;text-decoration:none}a:hover{text-decoration:underline}img{display:block;width:100%;height:auto;border-radius:5px}table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;font-size:14px}td,th{border:1px solid #30363d;text-align:left;padding:9px 13px;vertical-align:top}tr:nth-child(even){background:#161b22}pre{background:#161b22;border-radius:6px;padding:16px;overflow-x:auto}code{font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;background:#6e768126;border-radius:4px;padding:.2em .35em}pre code{padding:0;background:none}sub{display:block;color:#8b949e;font-size:12px;line-height:1.6}li{margin:6px 0}details{border-top:1px solid #30363d;padding-top:15px}summary{cursor:pointer}body>p{max-width:1012px;margin:18px auto;color:#8b949e;font-size:12px;padding:0 15px}@media(max-width:650px){main{margin:0;border:0;padding:20px}body{font-size:15px}table{font-size:12px}td,th{padding:7px}h1{font-size:28px}}`;
await writeFile(path.join(dir, 'readme-preview.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redline README — layout preview</title><style>${css}</style></head><body><p>README layout preview · <a href="redline-workspace.html">View the Document mockup</a></p><main>${body}</main></body></html>`);
console.log('readme-preview.html · generated from README.md');
