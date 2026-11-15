import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRoot = fileURLToPath(new URL('../.runtime/ffmpeg-macos/', import.meta.url));
const version = '9.0.1-1';
const checksums = {
  arm64: 'SSFe4diu+OZjdzF4M+J3Ip1vjR53gVUdawpHnZ5N1+5Sab+VfeJ8rxnEOUe7JfGuv1oSkBhyxY3gDEOQ5010Xg==',
  x64: 'rV0gxgpjkTKABk2h6UI9KmeU6uoXcGZ1GZwNd8zlk7vM9yLEgksMzt2/hE4QRTLty3ydUVDGyjd5TM6oTumw4w=='
};
const requiredFiles = ['bin/ffmpeg', 'bin/ffprobe', 'lib/libavcodec.63.dylib', 'LICENSES/ffmpeg/COPYING.LGPLv2.1'];

export async function prepareMacFfmpeg(arch = process.arch) {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`Unsupported macOS architecture: ${arch}`);
  const runtime = path.join(runtimeRoot, arch);
  const ready = () => [...requiredFiles, `.${version}`].every(file => existsSync(path.join(runtime, file)));
  if (ready()) return runtime;

  const packageName = `ffmpeg-macos-lgpl-${arch}`;
  const url = `https://registry.npmjs.org/@dfloresc/${packageName}/-/${packageName}-${version}.tgz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`FFmpeg download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha512').update(bytes).digest('base64') !== checksums[arch]) {
    throw new Error('FFmpeg checksum mismatch');
  }

  await mkdir(runtimeRoot, { recursive: true });
  const staging = await mkdtemp(path.join(runtimeRoot, 'download-'));
  try {
    const archive = path.join(staging, 'ffmpeg.tgz');
    await writeFile(archive, bytes);
    execFileSync('tar', ['-xzf', archive, '-C', staging], { stdio: 'inherit' });
    const extracted = path.join(staging, 'package');
    if (!requiredFiles.every(file => existsSync(path.join(extracted, file)))) {
      throw new Error('The verified FFmpeg archive is incomplete');
    }
    await writeFile(path.join(extracted, `.${version}`), '');
    if (!ready()) {
      await rm(runtime, { recursive: true, force: true });
      await rename(extracted, runtime);
    }
    return runtime;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
