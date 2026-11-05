'use strict';

// Local Linux AppImage update test: two packaged test builds, 0.1.0 and 0.1.1,
// and a loopback feed serving 0.1.1. Nothing touches git, GitHub or remote tags.
//
//   node scripts/updater-smoke.js build <out>          two test builds from an isolated copy
//   node scripts/updater-smoke.js serve <out>          the feed on http://127.0.0.1:47832/
//   node scripts/updater-smoke.js mode <out> <mode>    update | current | offline | bad-sha | missing
//
// The copy is made from the files git knows of under <out>/src-<version>; its package.json
// gets the test version, `capriUpdaterTest: true` and a generic publish feed on the loopback address.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 47832;
const VERSIONS = ['0.1.0', '0.1.1'];
const MODES = ['update', 'current', 'offline', 'bad-sha', 'missing'];

function snapshot(out, version) {
  const dir = path.join(out, `src-${version}`);
  fs.rmSync(dir, { recursive: true, force: true });

  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);

  for (const file of files) {
    const from = path.join(ROOT, file);
    if (!fs.statSync(from, { throwIfNoEntry: false })?.isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(from, path.join(dir, file));
  }

  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(dir, 'node_modules'));

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.version = version;
  pkg.capriUpdaterTest = true;

  pkg.build = pkg.build || {};
  pkg.build.publish = [{ provider: 'generic', url: `http://127.0.0.1:${PORT}/` }];
  delete pkg.build.mac;
  delete pkg.build.win;
  pkg.build.linux = {
    target: [{ target: 'AppImage', arch: [process.arch] }],
  };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return dir;
}

function build(out) {
  if (process.platform !== 'linux') throw new Error('Linux only');
  fs.mkdirSync(out, { recursive: true });

  for (const version of VERSIONS) {
    const dir = snapshot(out, version);
    console.log(`[updater-smoke] building ${version} in ${dir}`);

    execFileSync(
      process.execPath,
      [path.join(dir, 'node_modules', 'electron-builder', 'cli.js'), '--linux', 'AppImage', `--${process.arch}`, '--publish', 'never'],
      { cwd: dir, stdio: 'inherit', env: { ...process.env } }
    );

    const dest = path.join(out, version);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest);

    const dist = path.join(dir, 'dist');
    for (const name of fs.readdirSync(dist)) {
      if ((name.startsWith('latest-linux') && name.endsWith('.yml')) || name.endsWith('.AppImage') || name.endsWith('.blockmap')) {
        const targetPath = path.join(dest, name);
        fs.copyFileSync(path.join(dist, name), targetPath);
        if (name.endsWith('.AppImage')) {
          fs.chmodSync(targetPath, 0o755); // Make sure AppImage is executable
        }
      }
    }

    console.log(`[updater-smoke] ${version}: ${fs.readdirSync(dest).join(', ')}`);
  }
}

function serve(out) {
  const modeFile = path.join(out, 'mode');
  const mode = () => {
    const m = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'update';
    return MODES.includes(m) ? m : 'update';
  };

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const name = path.basename(decodeURIComponent(pathname));
    const m = mode();
    console.log(`[updater-smoke] ${m} ${req.method} /${name}`);

    if (m === 'offline') return res.writeHead(503).end('offline');

    // Linux update channel manifest (latest-linux.yml / latest-linux-x64.yml, etc.)
    if (name.startsWith('latest-linux') && name.endsWith('.yml')) {
      if (m === 'missing') return res.writeHead(404).end();
      const manifestPath = path.join(out, m === 'current' ? VERSIONS[0] : VERSIONS[1], name);
      if (!fs.existsSync(manifestPath)) return res.writeHead(404).end();
      return res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(fs.readFileSync(manifestPath));
    }

    // Update artifacts (AppImage and .blockmap)
    if (/\.AppImage(\.blockmap)?$/i.test(name)) {
      const file = path.join(out, VERSIONS[1], name);
      if (!fs.existsSync(file)) return res.writeHead(404).end();

      const bytes = fs.readFileSync(file);
      if (m === 'bad-sha' && name.endsWith('.AppImage')) {
        bytes[bytes.length >> 1] ^= 0xff; // We corrupt one byte to test the checksum.
      }
      return res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': bytes.length,
      }).end(bytes);
    }

    res.writeHead(404).end();
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[updater-smoke] feed on http://127.0.0.1:${PORT}/ (mode: ${mode()})`);
  });
}

const [command, out, arg] = process.argv.slice(2);
if (!out) {
  console.error('usage: node scripts/updater-smoke.js build|serve|mode <out> [mode]');
  process.exit(2);
}

const dir = path.resolve(out);
if (dir === ROOT || dir.startsWith(`${ROOT}${path.sep}`)) throw new Error('Use a folder outside the checkout');

if (command === 'build') build(dir);
else if (command === 'serve') serve(dir);
else if (command === 'mode' && MODES.includes(arg)) fs.writeFileSync(path.join(dir, 'mode'), arg);
else {
  console.error(`unknown command or mode (modes: ${MODES.join(', ')})`);
  process.exit(2);
}
