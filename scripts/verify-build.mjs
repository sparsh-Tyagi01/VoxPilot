import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
if (!manifest.action.default_popup || manifest.permissions.includes('sidePanel')) throw Error('Invalid popup build');
const assets = new URL('../dist/assets/', import.meta.url);
const files = await readdir(assets);
const runtimes = files.filter(file => /^ort-wasm-simd-threaded.*\.wasm$/.test(file));
if (runtimes.length !== 1) throw Error('Expected one ONNX runtime binary');
if (!files.some(file => /^ort-wasm-simd-threaded.*\.mjs$/.test(file))) throw Error('Missing ONNX runtime glue');
if (!files.some(file => /^silero_vad-.*\.onnx$/.test(file))) throw Error('Missing bundled speech detector');
if (!files.some(file => /^vad-worker-.*\.js$/.test(file))) throw Error('Missing speech detector worker');
const seen = new Set();
for (const file of runtimes) {
  const data = await readFile(new URL(file, assets));
  const hash = createHash('sha256').update(data).digest('hex');
  if (seen.has(hash)) throw Error('Duplicate ONNX binary');
  seen.add(hash);
}
try { await stat(new URL('../dist/onnx/', import.meta.url)); throw Error('Unused public ONNX copies remain'); }
catch(error) { if(error.code !== 'ENOENT') throw error; }
console.log('Verified popup, bundled speech detector and single-copy ONNX assets');
