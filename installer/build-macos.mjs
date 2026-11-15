import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { prepareMacFfmpeg } from './ffmpeg-macos.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const appName = 'NotoMixer';
const bundleId = 'com.exertia.notomixer';
const outputDir = path.join(root, 'dist', 'installer-mac');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const arch = process.argv[2] || process.arch;
const appIdentity = process.env.NOTOMIXER_MAC_APP_IDENTITY;
const installerIdentity = process.env.NOTOMIXER_MAC_INSTALLER_IDENTITY;
const notaryProfile = process.env.NOTOMIXER_MAC_NOTARY_PROFILE;

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

async function makeIcon(staging) {
  const iconset = path.join(staging, 'NotoMixer.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const suffix = scale === 2 ? '@2x' : '';
      run('sips', [
        '-z', pixels, pixels, path.join(root, 'logo.png'),
        '--out', path.join(iconset, `icon_${size}x${size}${suffix}.png`)
      ]);
    }
  }
  const icon = path.join(staging, 'NotoMixer.icns');
  run('iconutil', ['-c', 'icns', iconset, '-o', icon]);
  return icon;
}

async function build() {
  if (process.platform !== 'darwin') {
    throw new Error('Il comando richiede macOS. Puoi usare anche il workflow GitHub Actions «Installer macOS».');
  }
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`Architettura non supportata: ${arch}`);
  if (arch !== process.arch) throw new Error(`Usa Node.js ${arch} per compilare e verificare il pacchetto ${arch}.`);
  if (Boolean(appIdentity) !== Boolean(installerIdentity) || (notaryProfile && !appIdentity)) {
    throw new Error('Imposta entrambe le identità Developer ID prima di firmare o notarizzare.');
  }

  const ffmpegRuntime = await prepareMacFfmpeg(arch);
  await mkdir(outputDir, { recursive: true });
  const staging = await mkdtemp(path.join(os.tmpdir(), 'notomixer-mac-'));
  try {
    const assets = path.join(staging, 'assets');
    const defaults = path.join(staging, 'defaults');
    const ffmpeg = path.join(staging, 'ffmpeg');
    await cp(path.join(root, 'assets'), assets, { recursive: true });
    await cp(path.join(root, 'logo.svg'), path.join(assets, 'logo.svg'));
    await cp(path.join(root, 'logo.png'), path.join(assets, 'logo.png'));
    await cp(path.join(root, 'settings', 'userSettings.notomixer'), path.join(defaults, 'settings', 'userSettings.notomixer'));
    await cp(path.join(root, 'config.notomixer'), path.join(defaults, 'config.notomixer'));
    await cp(ffmpegRuntime, ffmpeg, { recursive: true, filter: source => !path.basename(source).startsWith('.') });

    const [appDir] = await packager({
      dir: root,
      name: appName,
      platform: 'darwin',
      arch,
      out: staging,
      appVersion: version,
      appBundleId: bundleId,
      icon: await makeIcon(staging),
      asar: true,
      prune: true,
      extraResource: [assets, defaults, ffmpeg],
      extendInfo: { LSMinimumSystemVersion: '12.0' },
      ignore: [
        /^\/(?:dist|installer|assets|settings|esp32-companion|\.runtime|\.build-tools|\.github|\.git|\.cover_cache)(?:$|\/)/,
        /^\/(?:config\.notomixer|logo\.(?:png|svg)|desktopApp\.zip|notoMixer\.ino|(?:build-installer|prepare-ffmpeg)\.(?:ps1|js)|INSTALLER\.md|avvia\.bat|\.gitignore)$/
      ],
      osxSign: appIdentity
        ? { identity: appIdentity }
        : { identity: '-', identityValidation: false, preAutoEntitlements: false, hardenedRuntime: false, timestamp: 'none' }
    });
    const app = path.join(appDir, `${appName}.app`);
    run('codesign', ['--verify', '--deep', '--strict', app]);

    const machoArch = arch === 'x64' ? 'x86_64' : arch;
    const ffmpegBin = path.join(app, 'Contents', 'Resources', 'ffmpeg', 'bin');
    const ffmpegExe = path.join(ffmpegBin, 'ffmpeg');
    const ffprobeExe = path.join(ffmpegBin, 'ffprobe');
    for (const file of [path.join(app, 'Contents', 'MacOS', appName), ffmpegExe, ffprobeExe]) {
      run('lipo', ['-verify_arch', machoArch, file]);
    }
    const testAudio = path.join(staging, 'test.m4a');
    run(ffmpegExe, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc', '-t', '0.1', '-c:a', 'alac', testAudio]);
    run(ffprobeExe, ['-v', 'error', '-show_entries', 'stream=codec_name', testAudio]);
    run(ffmpegExe, ['-v', 'error', '-i', testAudio, '-f', 'null', '-']);

    const filename = `${appName}${version}-macos-${arch}.pkg`;
    const temporaryPkg = path.join(staging, filename);
    const requirements = path.join(staging, 'requirements.plist');
    await writeFile(requirements, JSON.stringify({ arch: [machoArch], os: ['12.0'] }));
    run('plutil', ['-convert', 'xml1', requirements]);
    const buildArgs = ['--component', app, '/Applications', '--product', requirements];
    if (installerIdentity) buildArgs.push('--sign', installerIdentity);
    run('productbuild', [...buildArgs, temporaryPkg]);

    if (notaryProfile) {
      run('xcrun', ['notarytool', 'submit', temporaryPkg, '--keychain-profile', notaryProfile, '--wait']);
      run('xcrun', ['stapler', 'staple', temporaryPkg]);
    }

    const packageFiles = execFileSync('pkgutil', ['--payload-files', temporaryPkg], { encoding: 'utf8' });
    for (const file of ['MacOS/NotoMixer', 'Resources/app.asar', 'Resources/ffmpeg/bin/ffmpeg']) {
      if (!packageFiles.split('\n').some(entry => entry.endsWith(`NotoMixer.app/Contents/${file}`))) {
        throw new Error(`File mancante nel pacchetto: ${file}`);
      }
    }
    const output = path.join(outputDir, filename);
    // Use a sibling temporary file so the final rename works even across volumes.
    const delivery = await mkdtemp(path.join(outputDir, '.staging-'));
    try {
      const copy = path.join(delivery, filename);
      await cp(temporaryPkg, copy);
      await rename(copy, output);
    } finally {
      await rm(delivery, { recursive: true, force: true });
    }
    console.log(output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

build().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
