/** Real Chrome DOM/tool/UI smoke tests. The decision provider is a fixture, not an LLM benchmark. */
import { build } from 'vite';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const cpuBenchmark = process.env.VOXPILOT_CPU_BENCHMARK === '1' || process.argv.includes('--cpu');
const cpuConfig = JSON.parse(await readFile(path.join(root, 'src/shared/cpu-planner-config.json'), 'utf8'));
const modelDirectory = process.env.VOXPILOT_CPU_MODEL_DIR ?? path.join(tmpdir(), `voxpilot-cpu-model-${cpuConfig.revision.slice(0, 8)}`);
const modelPrefix = `/${cpuConfig.modelId}/resolve/${cpuConfig.revision}/`;
let weightNetworkRequests = 0;
const temporary = await mkdtemp(path.join(tmpdir(), 'voxpilot-site-smoke-'));
let browser; let server; let socket;
try {
  if (cpuBenchmark && (await stat(path.join(modelDirectory, cpuConfig.artifact))).size !== cpuConfig.artifactBytes) throw Error('Prepare the pinned CPU model with npm run benchmark:cpu:prepare first.');
  await build({ configFile: false, logLevel: 'error', worker: { format: 'es' }, resolve: { alias: { '@shared': path.join(root, 'src/shared') } }, build: { target: 'esnext', outDir: path.join(temporary, 'build'), rollupOptions: { input: cpuBenchmark ? { cpu: path.join(root, 'tests/browser/cpu-benchmark.ts') } : { site: path.join(root, 'tests/browser/site-harness.ts'), popup: path.join(root, 'tests/browser/popup-harness.ts'), settings: path.join(root, 'tests/browser/settings-harness.ts'), hosted: path.join(root, 'tests/browser/hosted-harness.ts') }, output: { entryFileNames: '[name].js' } } } });
  server = http.createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${cpuBenchmark ? " 'wasm-unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'`);
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (!cpuBenchmark && pathname === '/provider/v1/chat/completions' && request.method === 'POST') {
        let raw = '';
        for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 32768) throw Error('Fixture request too large'); }
        const body = JSON.parse(raw);
        if (request.headers.authorization !== 'Bearer synthetic-key') { response.statusCode = 401; response.end(); return; }
        const user = body.messages.findLast(message => message.role === 'user').content;
        const data = JSON.parse(user.split('<page_data>')[1].split('</page_data>')[0]);
        const step = data.history.length;
        let decision;
        if (body.model === 'fixture-search') decision = step === 0
          ? { kind: 'act', action: { type: 'type', handle: data.elements.find(el => el.type === 'search').id, text: 'backpacks' }, expected: { kind: 'control_state' } }
          : step === 1 ? { kind: 'act', action: { type: 'submit', handle: data.forms.find(form => form.search).id }, expected: { kind: 'text_appeared', text: 'Results for backpacks' } }
            : { kind: 'finish', message: 'Found backpack results.', evidence: ['Results for backpacks'] };
        else if (body.model === 'fixture-cart') decision = step === 0
          ? { kind: 'act', action: { type: 'select', handle: data.elements.find(el => el.tag === 'select').id, option: 'Medium' }, expected: { kind: 'control_state' } }
          : step === 1 ? { kind: 'act', action: { type: 'click', handle: data.elements.find(el => el.name === 'Add to cart').id }, expected: { kind: 'text_appeared', text: 'One medium shirt added to cart' } }
            : { kind: 'finish', message: 'Added one medium shirt.', evidence: ['One medium shirt added to cart'] };
        else if (body.model === 'fixture-invalid') decision = { kind: 'act', action: { type: 'eval', code: 'doSomething()' } };
        else { await new Promise(resolve => setTimeout(resolve, 200)); decision = { kind: 'unavailable', reason: 'not_found_in_scope', message: 'Fixture response.' }; }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })); return;
      }
      if (pathname === '/hosted') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Hosted planner HTTP fixture</title><script type="module" src="/hosted.js"></script>'); return; }
      if (cpuBenchmark && pathname.startsWith(modelPrefix)) {
        const suffix = pathname.slice(modelPrefix.length);
        const filename = path.resolve(modelDirectory, suffix);
        if (!filename.startsWith(path.resolve(modelDirectory) + path.sep)) throw Error('Invalid model path');
        const size = (await stat(filename)).size;
        if (filename.endsWith('.onnx')) weightNetworkRequests++;
        response.setHeader('Content-Length', size); response.setHeader('Content-Type', filename.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        createReadStream(filename).pipe(response); return;
      }
      if (pathname === '/popup') {
        response.setHeader('Content-Type', 'text/html');
        response.end((await readFile(path.join(root, 'src/panel/panel.html'), 'utf8')).replace('src="./panel.ts"', 'src="/popup.js"')); return;
      }
      if (pathname === '/settings' || pathname === '/settings-small') {
        response.setHeader('Content-Type', 'text/html');
        response.end((await readFile(path.join(root, 'src/settings/settings.html'), 'utf8')).replace('src="./settings.ts"', 'src="/settings.js"')); return;
      }
      if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(`<title>VoxPilot browser fixture</title><script type="module" src="/${cpuBenchmark ? 'cpu' : 'site'}.js"></script>`); return; }
      const filename = path.resolve(temporary, 'build', '.' + pathname);
      if (!filename.startsWith(path.join(temporary, 'build') + path.sep)) throw Error('Invalid path');
      response.setHeader('Content-Type', /\.(mjs|js)$/.test(filename) ? 'application/javascript' : filename.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'); response.end(await readFile(filename));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  let executable;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
  if (!executable) throw Error('Set CHROME_PATH to a Chrome/Chromium executable.');
  browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', ...(cpuBenchmark ? ['--disable-gpu', '--disable-features=WebGPU'] : []), '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  if (cpuBenchmark) socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.consoleAPICalled') for (const argument of message.params.args ?? []) if (typeof argument.value === 'string' && argument.value.startsWith('CPU benchmark:')) console.log(argument.value); });
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await command('Page.enable');
  if (cpuBenchmark) await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 350, height: 800, deviceScaleFactor: 1, mobile: false });
  for (const route of cpuBenchmark ? ['/'] : ['/', '/hosted', '/popup', '/settings', '/settings-small']) {
    if (route.startsWith('/settings')) await command('Emulation.setDeviceMetricsOverride', { width: route === '/settings-small' ? 420 : 1024, height: 1100, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}${route}` });
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await command('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(window.smokeResult)resolve(window.smokeResult);else if(Date.now()-start>${cpuBenchmark ? 360000 : 20000})reject(Error("Fixture timed out"));else setTimeout(check,50)};check()})` });
    if (!result.result?.value) throw Error(JSON.stringify({ route, result }));
    const report = { route, ...result.result.value };
    if (cpuBenchmark) {
      report.weightNetworkRequests = weightNetworkRequests;
      report.cachePassed = weightNetworkRequests === 1 && report.cachedDownloadEvents === 0;
      report.ok = report.ok && report.cachePassed;
    }
    console.log(JSON.stringify(report));
    if (!report.ok) throw Error(cpuBenchmark ? 'CPU planner failed task correctness, GPU-independence or cache checks; see benchmark report above.' : 'Browser fixture failed; see report above.');
    if (route === '/popup' && process.env.VOXPILOT_SCREENSHOT) {
      const capture = await command('Page.captureScreenshot', { format: 'png' });
      const { writeFile } = await import('node:fs/promises'); await writeFile(process.env.VOXPILOT_SCREENSHOT, Buffer.from(capture.data, 'base64'));
    }
    if (route.startsWith('/settings') && process.env.VOXPILOT_SETTINGS_SCREENSHOT) {
      const capture = await command('Page.captureScreenshot', { format: 'png' });
      const { writeFile } = await import('node:fs/promises'); await writeFile(process.env.VOXPILOT_SETTINGS_SCREENSHOT.replace('.png', route === '/settings-small' ? '-small.png' : '.png'), Buffer.from(capture.data, 'base64'));
    }
  }
  await command('Browser.close');
} finally {
  socket?.close(); browser?.kill('SIGTERM'); server?.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
