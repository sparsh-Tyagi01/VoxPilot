/** Optional real-model benchmark preparation. No model weights enter the repository. */
import { readFile, mkdir, stat, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
const config = JSON.parse(await readFile(new URL('../src/shared/cpu-planner-config.json', import.meta.url), 'utf8'));
const directory = process.env.VOXPILOT_CPU_MODEL_DIR ?? path.join(tmpdir(), `voxpilot-cpu-model-${config.revision.slice(0, 8)}`);
for (const name of ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', config.artifact]) {
  const filename = path.join(directory, name); await mkdir(path.dirname(filename), { recursive: true });
  let present = false;
  try { present = (await stat(filename)).size > 0; } catch {}
  if (!present) {
    const partial = filename + '.part';
    await new Promise((resolve, reject) => {
      const child = spawn('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--connect-timeout', '20', '--max-time', '900', '--output', partial, `https://huggingface.co/${config.modelId}/resolve/${config.revision}/${name}`], { stdio: ['ignore', 'ignore', 'inherit'] });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`Download failed: ${name}`)));
    });
    await rename(partial, filename);
  }
  console.log(`${name}: ${(await stat(filename)).size} bytes`);
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(path.join(directory, config.artifact))) hash.update(chunk);
if (hash.digest('hex') !== config.artifactSha256) throw Error('CPU model integrity check failed. Remove the cached model and rerun preparation.');
console.log(`Verified pinned model SHA-256. Set VOXPILOT_CPU_MODEL_DIR=${directory}`);
