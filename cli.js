#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const DEFAULT_BUCKET = 'devtalk-files';
const ROOM_ID = 'general';
const CONFIG_DIR = path.join(os.homedir(), '.devtalk');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const peerId = createId();

function createId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function getArg(name) {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) {
    return '';
  }
  return process.argv[index + 1] || '';
}

function loadSavedConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  await fs.promises.mkdir(CONFIG_DIR, { mode: 0o700, recursive: true });
  await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function getConfig(saved = {}) {
  return {
    url: getArg('url') || process.env.DEVTALK_SUPABASE_URL || saved.url || '',
    anonKey: getArg('key') || process.env.DEVTALK_SUPABASE_ANON_KEY || saved.anonKey || '',
    bucket: getArg('bucket') || process.env.DEVTALK_STORAGE_BUCKET || saved.bucket || DEFAULT_BUCKET,
    nickname: getArg('name') || process.env.DEVTALK_NICKNAME || saved.nickname || os.userInfo().username || os.hostname() || 'terminal',
    theme: getArg('theme') || process.env.DEVTALK_THEME || saved.theme || 'default'
  };
}

function ask(rl, question, defaultValue = '') {
  const suffix = defaultValue ? ' [' + defaultValue + ']' : '';
  return new Promise((resolve) => {
    rl.question(question + suffix + ': ', (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

function askSensitive(rl, question, defaultValue = '') {
  const suffix = defaultValue ? ' [saved]' : '';
  return new Promise((resolve) => {
    rl.question(question + suffix + ': ', (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function ensureConfig() {
  const saved = loadSavedConfig();
  const config = getConfig(saved);

  if (config.url && config.anonKey) {
    return config;
  }

  console.log('DevTalk first-time terminal setup');
  console.log('Saved at ' + CONFIG_PATH);
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    config.url = config.url || await ask(rl, 'Supabase URL');
    config.anonKey = config.anonKey || await askSensitive(rl, 'Supabase anon key');
    config.bucket = await ask(rl, 'Storage bucket', config.bucket || DEFAULT_BUCKET);
    config.nickname = await ask(rl, 'Nickname', config.nickname || 'terminal');
    config.theme = normalizeTheme(await ask(rl, 'Theme', config.theme || 'default'));
  } finally {
    rl.close();
  }

  if (!config.url || !config.anonKey) {
    throw new Error('Supabase URL and anon key are required.');
  }

  await saveConfig(config);
  console.log('Saved DevTalk terminal settings.');
  console.log('');
  return config;
}

async function editSavedConfig() {
  const saved = loadSavedConfig();
  const config = getConfig(saved);
  await promptConfig(config);
  await saveConfig(config);
  console.log('Saved DevTalk terminal settings.');
}

async function promptConfig(config) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    config.url = await ask(rl, 'Supabase URL', config.url);
    config.anonKey = await askSensitive(rl, 'Supabase anon key', config.anonKey);
    config.bucket = await ask(rl, 'Storage bucket', config.bucket || DEFAULT_BUCKET);
    config.nickname = await ask(rl, 'Nickname', config.nickname || 'terminal');
    config.theme = normalizeTheme(await ask(rl, 'Theme', config.theme || 'default'));
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log('DevTalk terminal');
  console.log('');
  console.log('Usage: devtalk [--url <supabase-url>] [--key <anon-key>] [--bucket devtalk-files] [--name you] [--theme default|work]');
  console.log('       devtalk /config');
  console.log('       devtalk --config');
  console.log('');
  console.log('Settings are saved at ' + CONFIG_PATH + ' after first setup.');
  console.log('CLI arguments and environment variables override saved settings.');
  console.log('');
  console.log('Environment variables:');
  console.log('  DEVTALK_SUPABASE_URL');
  console.log('  DEVTALK_SUPABASE_ANON_KEY');
  console.log('  DEVTALK_STORAGE_BUCKET');
  console.log('  DEVTALK_NICKNAME');
  console.log('  DEVTALK_THEME');
  console.log('');
  console.log('Commands:');
  console.log('  /file <path>   upload a file up to 5 MB');
  console.log('  /theme [name]  switch default/work terminal output');
  console.log('  /config        edit saved terminal settings');
  console.log('  /help          show this help');
  console.log('  /quit          exit');
}

function safeFileName(name) {
  const cleaned = name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.slice(0, 120) || 'file';
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatSize(value) {
  if (!value) return '';
  if (value < 1024 * 1024) return Math.ceil(value / 1024) + ' KB';
  return (value / 1024 / 1024).toFixed(1) + ' MB';
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip'
  };
  return types[ext] || 'application/octet-stream';
}

function normalizeTheme(value) {
  return value === 'work' ? 'work' : 'default';
}

function renderMessage(message, theme = 'default') {
  for (const line of formatMessage(message, theme)) {
    console.log(line);
  }
}

function formatMessage(message, theme = 'default') {
  const who = message.mine ? 'you' : message.nickname || 'someone';
  const text = message.text ? ' ' + message.text : '';
  const lines = [];

  if (theme === 'work') {
    lines.push(`${formatTime(message.sentAt)} ${who}${text}`);
  } else {
    lines.push(`[${formatTime(message.sentAt)}] ${who}:${text}`);
  }

  if (message.attachment) {
    const meta = [message.attachment.type, formatSize(message.attachment.size)].filter(Boolean).join(' · ');
    lines.push(`  file: ${message.attachment.name}${meta ? ' (' + meta + ')' : ''}`);
    lines.push(`  url: ${message.attachment.url}`);
  }

  return lines;
}

function renderMessageAbovePrompt(rl, message, theme = 'default') {
  if (!process.stdout.isTTY) {
    renderMessage(message, theme);
    rl.prompt();
    return;
  }

  const currentLine = rl.line;
  const currentCursor = rl.cursor;

  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  for (const line of formatMessage(message, theme)) {
    console.log(line);
  }
  rl.prompt(true);
  if (currentLine) {
    rl.write(currentLine);
    if (currentCursor < currentLine.length) {
      readline.moveCursor(process.stdout, currentCursor - currentLine.length, 0);
    }
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }
  if (process.argv.includes('/config') || process.argv.includes('--config')) {
    await editSavedConfig();
    return;
  }

  const config = await ensureConfig();
  config.theme = normalizeTheme(config.theme);

  const supabase = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  const channel = supabase.channel('devtalk:' + ROOM_ID, {
    config: {
      broadcast: {
        self: false
      }
    }
  });

  const seen = new Set();
  let ready = false;

  channel.on('broadcast', { event: 'message' }, ({ payload }) => {
    if (!payload || payload.kind !== 'devtalk-message' || payload.peerId === peerId) {
      return;
    }
    if (payload.id && seen.has(payload.id)) {
      return;
    }
    if (payload.id) {
      seen.add(payload.id);
    }
    renderMessageAbovePrompt(rl, {
      id: payload.id || createId(),
      nickname: String(payload.nickname || 'someone'),
      text: String(payload.text || ''),
      attachment: payload.attachment,
      sentAt: Number(payload.sentAt) || Date.now(),
      mine: false
    }, config.theme);
  });

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      ready = true;
      console.log(`Connected to DevTalk room ${ROOM_ID} as ${config.nickname}.`);
      console.log('Type /help for commands.');
      rl.prompt();
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      console.error('DevTalk connection status:', status);
    }
  });

  async function publish(message) {
    if (message.id) {
      seen.add(message.id);
    }

    const result = await channel.send({
      type: 'broadcast',
      event: 'message',
      payload: message
    });

    if (result !== 'ok') {
      console.error('Message was not sent. Supabase returned:', result);
      return;
    }

    renderMessage({ ...message, mine: true }, config.theme);
  }

  async function editConfig() {
    await promptConfig(config);
    await saveConfig(config);
    console.log('Saved DevTalk terminal settings. Restart DevTalk if URL or key changed.');
  }

  async function setTheme(value) {
    const nextTheme = value || (config.theme === 'work' ? 'default' : 'work');
    if (!['default', 'work'].includes(nextTheme)) {
      console.error('Usage: /theme [default|work]');
      return;
    }
    config.theme = nextTheme;
    await saveConfig(config);
    console.log('Theme changed to ' + nextTheme + '.');
  }

  async function sendText(text) {
    await publish({
      id: createId(),
      kind: 'devtalk-message',
      peerId,
      nickname: config.nickname,
      text,
      sentAt: Date.now()
    });
  }

  async function sendFile(rawPath) {
    const filePath = path.resolve(rawPath.replace(/^['"]|['"]$/g, ''));
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      console.error('Not a file:', filePath);
      return;
    }
    if (stat.size > MAX_FILE_SIZE) {
      console.error('Files must be 5 MB or smaller.');
      return;
    }

    const name = safeFileName(path.basename(filePath));
    const type = guessContentType(filePath);
    const objectPath = [
      ROOM_ID,
      new Date().toISOString().slice(0, 10),
      createId() + '-' + name
    ].join('/');
    const buffer = await fs.promises.readFile(filePath);

    console.log('Uploading', name + '...');
    const { error } = await supabase.storage
      .from(config.bucket)
      .upload(objectPath, buffer, {
        contentType: type,
        upsert: false
      });

    if (error) {
      console.error('File upload failed:', error.message);
      return;
    }

    const { data } = supabase.storage
      .from(config.bucket)
      .getPublicUrl(objectPath);

    await publish({
      id: createId(),
      kind: 'devtalk-message',
      peerId,
      nickname: config.nickname,
      text: '',
      attachment: {
        name,
        type,
        size: buffer.byteLength,
        url: data.publicUrl,
        path: objectPath,
        isImage: type.startsWith('image/')
      },
      sentAt: Date.now()
    });
  }

  let lastInterruptAt = 0;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
  });

  rl.on('SIGINT', () => {
    const now = Date.now();
    if (now - lastInterruptAt < 1500) {
      rl.close();
      return;
    }

    lastInterruptAt = now;
    console.log('Press Ctrl+C again to exit DevTalk.');
    rl.prompt();
  });

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (text === '/quit' || text === '/exit') {
      rl.close();
      return;
    }
    if (text === '/help') {
      printHelp();
      rl.prompt();
      return;
    }
    if (text === '/config') {
      await editConfig();
      rl.prompt();
      return;
    }
    if (text === '/theme' || text.startsWith('/theme ')) {
      await setTheme(text.slice('/theme'.length).trim());
      rl.prompt();
      return;
    }
    if (!ready) {
      console.error('DevTalk is still connecting.');
      rl.prompt();
      return;
    }

    try {
      if (text.startsWith('/file ')) {
        await sendFile(text.slice('/file '.length).trim());
      } else {
        await sendText(text);
      }
    } catch (error) {
      console.error(error.message);
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    await supabase.removeChannel(channel);
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
