/** Real Chrome DOM/tool/UI smoke tests. The decision provider is a fixture, not an LLM benchmark. */
import { build } from 'vite';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'voxpilot-site-smoke-'));
let browser; let server; let socket;
try {
  await build({ configFile: false, logLevel: 'error', resolve: { alias: { '@shared': path.join(root, 'src/shared') } }, build: { target: 'esnext', outDir: path.join(temporary, 'build'), rollupOptions: { input: { site: path.join(root, 'tests/browser/site-harness.ts'), popup: path.join(root, 'tests/browser/popup-harness.ts') }, output: { entryFileNames: '[name].js' } } } });
  server = http.createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'");
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/popup') {
        response.setHeader('Content-Type', 'text/html');
        response.end((await readFile(path.join(root, 'src/panel/panel.html'), 'utf8')).replace('src="./panel.ts"', 'src="/popup.js"')); return;
      }
      if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<title>VoxPilot browser fixture</title><script type="module" src="/site.js"></script>'); return; }
      const filename = path.resolve(temporary, 'build', '.' + pathname);
      if (!filename.startsWith(path.join(temporary, 'build') + path.sep)) throw Error('Invalid path');
      response.setHeader('Content-Type', filename.endsWith('.js') ? 'application/javascript' : 'application/octet-stream'); response.end(await readFile(filename));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  let executable;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
  if (!executable) throw Error('Set CHROME_PATH to a Chrome/Chromium executable.');
  browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Chrome did not open a debugging endpoint')), 15000);
    browser.stderr.on('data', chunk => { const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    browser.on('error', reject); browser.on('exit', code => { clearTimeout(timeout); reject(Error(`Isolated Chrome exited: ${code}`)); });
  });
  const targets = await (await fetch(`http://${new URL(endpoint).host}/json`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { const operation = pending.get(message.id); pending.delete(message.id); message.error ? operation.reject(Error(JSON.stringify(message.error))) : operation.resolve(message.result); } });
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 350, height: 800, deviceScaleFactor: 1, mobile: false });
  for (const route of ['/', '/popup']) {
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}${route}` });
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await command('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: 'new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(window.smokeResult)resolve(window.smokeResult);else if(Date.now()-start>20000)reject(Error("Fixture timed out"));else setTimeout(check,50)};check()})' });
    if (!result.result?.value?.ok) throw Error(JSON.stringify({ route, result }));
    console.log(JSON.stringify({ route, ...result.result.value }));
    if (route === '/popup' && process.env.VOXPILOT_SCREENSHOT) {
      const capture = await command('Page.captureScreenshot', { format: 'png' });
      const { writeFile } = await import('node:fs/promises'); await writeFile(process.env.VOXPILOT_SCREENSHOT, Buffer.from(capture.data, 'base64'));
    }
  }
  await command('Browser.close');
} finally {
  socket?.close(); browser?.kill('SIGTERM'); server?.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
