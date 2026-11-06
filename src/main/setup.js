'use strict';

// Setting her up with buttons, so nobody has to type in a terminal: Ollama (installed with winget,
// woken up, a model fetched with its progress), an API key pasted in her panel (kept encrypted with
// your Windows account), and Claude Code or Codex run through Ollama in a window of their own.

const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const { safeStorage } = require('electron');
const ollama = require('./ollama');

// The models she offers for her chat, with what they weigh (as Ollama lists them)
const MODELS = [
  { name: 'gemma3:4b', bytes: 3.3e9 }, // better in languages other than English
  { name: 'llama3.2', bytes: 2.0e9 },  // lighter
];

// Where to get a key, by provider (llm.js)
const KEY_PAGES = {
  groq: 'https://console.groq.com/keys',
  gemini: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/keys',
  openai: 'https://platform.openai.com/api-keys',
  mistral: 'https://console.mistral.ai/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
};

function which(cmd) {
  return new Promise((resolve) => {
    execFile( 'which', [cmd], { windowsHide: true, timeout: 5000 }, (err, out) => (
      resolve(err ? null : String(out).split(/\r?\n/)[0].trim() || null)));
  });
}

// Ollama's own app (it runs the server from the tray) and its command, where its installer puts them
function ollamaFiles() {
  return { app: '', cli: '' };
}

// { running, installed, models, winget }: how far along Ollama is on this PC
async function ollamaState() {
  const models = await ollama.models().catch(() => null);
  if (models) return { running: true, installed: true, models, winget: false };
  const [onPath, winget] = await Promise.all([which('ollama'), null]);
  return { running: false, installed: fs.existsSync(ollamaFiles().cli) || Boolean(onPath), models: null, winget: Boolean(winget) };
}

// onLine(text) for what it prints.
function installOllama(onLine) {
  const message = [
    'Install Ollama via terminal:',
    '',
    '• Arch Linux:',
    '    sudo pacman -S ollama',
    '    (for NVIDIA GPU: sudo pacman -S ollama-cuda)',
    '    (for AMD GPU:    sudo pacman -S ollama-rocm)',
    '',
    '• Ubuntu / Debian / Fedora / Others:',
    '    curl -fsSL https://ollama.com/install.sh | sh',
    '',
    '• After installation, enable and start the service:',
    '    sudo systemctl enable --now ollama',
    '',
    'Then retry in the app.'
  ].join('\n');

  onLine?.(message);
  return Promise.resolve({ ok: false, error: message });
}

// Wakes Ollama up (its app, else `ollama serve` in the background) and waits for it to answer.
async function startOllama() {
  const { app, cli } = ollamaFiles();
  const run = (file, args) => spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  if (fs.existsSync(app)) run(app, []);
  else run(fs.existsSync(cli) ? cli : 'ollama', ['serve']);
  for (let i = 0; i < 40; i++) {
    if (await ollama.models().catch(() => null)) return { ok: true };
    await new Promise((r) => setTimeout(r, 750));
  }
  return { ok: false, error: 'Ollama did not answer' };
}

// Fetches a model. Ollama sends its pieces one after the other: onProgress({ completed, total })
// adds them up, so the bar goes once from empty to full.
async function pullModel(name, onProgress, signal) {
  const res = await fetch(`${ollama.base()}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  const pieces = new Map(); // digest -> { completed, total }
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.digest && msg.total) pieces.set(msg.digest, { completed: msg.completed || 0, total: msg.total });
      let completed = 0;
      let total = 0;
      for (const p of pieces.values()) {
        completed += p.completed;
        total += p.total;
      }
      onProgress?.({ completed, total, status: msg.status });
      if (msg.status === 'success') return;
    }
  }
}

// Claude Code (or Codex) through Ollama, in a window of its own: Ollama fetches what's missing and
// asks which model to use. She sees it like any other session, through her hooks.
// Linux: the first terminal there is, with the command run in it and the window left open after
const TERMINALS = [
  ['konsole', ['-e']],
  ['xdg-terminal-exec', []],
  ['gnome-terminal', ['--']],
  ['kitty', []],
  ['alacritty', ['-e']],
  ['xterm', ['-e']],
];

async function launchInTerminal(integration) {
  for (const [terminal, prefix] of TERMINALS) {
    if (!(await which(terminal))) continue;
    // integration is one of two fixed words (checked by the caller): nothing of yours in the command
    spawn(terminal, [...prefix, 'bash', '-lc', `ollama launch ${integration}; exec bash`], { detached: true, stdio: 'ignore' })
      .on('error', () => {}).unref();
    return { ok: true };
  }
  return { ok: false, error: 'no terminal found' };
}

function launchThroughOllama(integration) {
  if (!['claude', 'codex'].includes(integration)) return { ok: false };
  if (process.platform === 'linux') return launchInTerminal(integration);
  else return { ok: false };
}

// API keys are kept encrypted in config.json, with your Windows account (DPAPI): "enc:<base64>".
function sealKey(key) {
  return safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(key).toString('base64')}` : key;
}

function openKey(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc:')) return stored || '';
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  } catch {
    return '';
  }
}

const openKeys = (apiKeys = {}) => Object.fromEntries(Object.entries(apiKeys).map(([id, v]) => [id, openKey(v)]));

module.exports = {
  MODELS, KEY_PAGES, ollamaState, installOllama, startOllama, pullModel, launchThroughOllama, sealKey, openKeys,
};
