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
const SPEAKER_COLORS = [
  [255, 226, 230],
  [255, 239, 199],
  [242, 245, 181],
  [213, 245, 204],
  [201, 244, 232],
  [199, 235, 255],
  [218, 224, 255],
  [236, 218, 255],
  [255, 218, 242],
  [224, 224, 224]
];

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
    theme: getArg('theme') || process.env.DEVTALK_THEME || saved.theme || 'default',
    colorMode: normalizeColorMode(getArg('color-mode') || process.env.DEVTALK_COLOR_MODE || saved.colorMode, true),
    statusLine: normalizeColorMode(getArg('status') || process.env.DEVTALK_STATUS_LINE || saved.statusLine, true)
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
    config.colorMode = normalizeColorMode(await ask(rl, 'Color mode', config.colorMode ? 'on' : 'off'), true);
    config.statusLine = normalizeColorMode(await ask(rl, 'Status line', config.statusLine ? 'on' : 'off'), true);
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
    config.colorMode = normalizeColorMode(await ask(rl, 'Color mode', config.colorMode ? 'on' : 'off'), true);
    config.statusLine = normalizeColorMode(await ask(rl, 'Status line', config.statusLine ? 'on' : 'off'), true);
  } finally {
    rl.close();
  }
}

function getHelpLines() {
  return [
    'DevTalk terminal',
    '',
    'Usage: devtalk [--url <supabase-url>] [--key <anon-key>] [--bucket devtalk-files] [--name you] [--theme default|work] [--color-mode on|off]',
    '       devtalk /config',
    '       devtalk --config',
    '',
    'Settings are saved at ' + CONFIG_PATH + ' after first setup.',
    'CLI arguments and environment variables override saved settings.',
    '',
    'Environment variables:',
    '  DEVTALK_SUPABASE_URL',
    '  DEVTALK_SUPABASE_ANON_KEY',
    '  DEVTALK_STORAGE_BUCKET',
    '  DEVTALK_NICKNAME',
    '  DEVTALK_THEME',
    '  DEVTALK_COLOR_MODE',
    '',
    'Commands:',
    '  /file <path>   upload a file up to 5 MB',
    '  /theme [name]  switch default/work terminal output',
    '  /color-mode    toggle speaker pastel highlights',
    '  /status        toggle the bottom status line',
    '  /config        edit saved terminal settings',
    '  /help          show this help',
    '  /quit          exit'
  ];
}

function printHelp() {
  for (const line of getHelpLines()) {
    console.log(line);
  }
}

function safeFileName(name) {
  const cleaned = name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.slice(0, 120) || 'file';
}

function safeStorageKey(name) {
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : '';

  const sanitize = (value) => value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

  const safeBase = sanitize(base) || 'file';
  const safeExt = sanitize(ext);
  const joined = safeExt ? safeBase + '.' + safeExt.replace(/^\.+/, '') : safeBase;
  return joined.slice(0, 120) || 'file';
}

function sanitizeTerminalText(value, max = 4000) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[\x00-\x08\x0B-\x1F\x7F\x9B]/g, '').slice(0, max);
}

function sanitizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') {
    return undefined;
  }
  const url = typeof attachment.url === 'string' ? attachment.url.trim() : '';
  if (!url || url.length > 2048) {
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  const rawType = typeof attachment.type === 'string' ? attachment.type.trim().toLowerCase().slice(0, 100) : '';
  const type = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(rawType) ? rawType : 'application/octet-stream';
  return {
    name: sanitizeTerminalText(attachment.name, 120) || 'file',
    type,
    size: Number.isFinite(Number(attachment.size)) && Number(attachment.size) > 0 ? Math.min(Number(attachment.size), MAX_FILE_SIZE) : 0,
    url: parsed.toString()
  };
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

function normalizeColorMode(value, defaultValue = true) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'color', 'colors'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off', 'plain'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function renderMessage(message, theme = 'default') {
  for (const line of formatMessage(message, theme)) {
    console.log(line);
  }
}

function formatMessage(message, theme = 'default', options = {}) {
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

  if (!options.colorMode || !process.stdout.isTTY) {
    return lines;
  }

  return colorizeMessageLines(lines, message, options.speakerColors);
}

function getSpeakerKey(message) {
  return message.peerId || message.nickname || (message.mine ? 'you' : 'someone');
}

function getSpeakerColor(message, speakerColors) {
  if (!speakerColors) {
    return SPEAKER_COLORS[0];
  }

  const key = getSpeakerKey(message);
  if (!speakerColors.has(key)) {
    speakerColors.set(key, speakerColors.size % SPEAKER_COLORS.length);
  }

  return SPEAKER_COLORS[speakerColors.get(key)];
}

function colorizeMessageLines(lines, message, speakerColors) {
  const [red, green, blue] = getSpeakerColor(message, speakerColors);
  const bg = `\x1b[48;2;${red};${green};${blue}m`;
  const fg = '\x1b[38;2;30;30;30m';
  const reset = '\x1b[0m';

  return lines.map((line) => `${bg}${fg} ${line} ${reset}`);
}

function getParticipantsFromPresenceState(state) {
  const participants = [];

  for (const [key, entries] of Object.entries(state || {})) {
    const entry = Array.isArray(entries) ? entries[entries.length - 1] : undefined;
    if (!entry) {
      continue;
    }

    const rawId = typeof entry.peerId === 'string' ? entry.peerId : String(key || '');
    const id = rawId.slice(0, 128);
    participants.push({
      peerId: id,
      nickname: sanitizeTerminalText(entry.nickname, 32) || 'someone',
      mine: id === peerId
    });
  }

  return participants.sort((a, b) => {
    if (a.mine) return -1;
    if (b.mine) return 1;
    return a.nickname.localeCompare(b.nickname);
  });
}

function formatPresenceLabel(participants) {
  const count = participants.length;
  const names = participants
    .slice(0, 3)
    .map((item) => item.mine ? 'you' : item.nickname);
  const suffix = count > 3 ? ' +' + (count - 3) : '';

  return count + ' online' + (names.length ? ' · ' + names.join(', ') + suffix : '');
}

function visibleLength(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function truncateVisible(value, width) {
  const text = String(value);
  if (visibleLength(text) <= width) {
    return text;
  }

  return text.slice(0, Math.max(0, width - 1)) + '…';
}

function createChatUi({ onLine, onClose, statusLineEnabled = true }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> '
    });

    rl.on('line', async (line) => {
      await onLine(line);
      rl.prompt();
    });
    rl.on('close', onClose);

    return {
      start() {
        rl.prompt();
      },
      writeLines(lines) {
        for (const line of lines) {
          console.log(line);
        }
        rl.prompt();
      },
      close() {
        rl.close();
      }
    };
  }

  let input = '';
  let cursor = 0;
  let closed = false;
  let lastInterruptAt = 0;
  let handling = Promise.resolve();
  let presenceLabel = '0 online';
  let showStatusLine = Boolean(statusLineEnabled);

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  function divider() {
    return '─'.repeat(Math.max(20, process.stdout.columns || 80));
  }

  function statusLine() {
    const columns = process.stdout.columns || 80;
    return truncateVisible('DevTalk · ' + presenceLabel, Math.max(12, columns));
  }

  function drawInputBlock() {
    if (showStatusLine) {
      process.stdout.write(statusLine() + '\n');
    }
    process.stdout.write(divider() + '\n');
    process.stdout.write('> ' + input);
    moveCursorToInputPosition();
  }

  function clearInputBlock() {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    readline.moveCursor(process.stdout, 0, -1);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    if (showStatusLine) {
      readline.moveCursor(process.stdout, 0, -1);
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
    }
  }

  function moveCursorToInputPosition() {
    const offset = input.length - cursor;
    if (offset > 0) {
      readline.moveCursor(process.stdout, -offset, 0);
    }
  }

  function redrawInputLine() {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write('> ' + input);
    moveCursorToInputPosition();
  }

  function redrawInputBlock() {
    clearInputBlock();
    drawInputBlock();
  }

  function setPresenceLabel(label) {
    presenceLabel = label || '0 online';
    if (!closed && showStatusLine) {
      redrawInputBlock();
    }
  }

  function setStatusLineEnabled(enabled) {
    if (showStatusLine === Boolean(enabled)) {
      return;
    }

    if (!closed) {
      clearInputBlock();
      showStatusLine = Boolean(enabled);
      drawInputBlock();
      return;
    }

    showStatusLine = Boolean(enabled);
  }

  function writeLines(lines) {
    if (closed) {
      return;
    }

    clearInputBlock();
    for (const line of lines) {
      console.log(line);
    }
    drawInputBlock();
  }

  function submitInput() {
    const line = input;
    input = '';
    cursor = 0;
    clearInputBlock();
    drawInputBlock();

    handling = handling
      .then(() => onLine(line))
      .catch((error) => writeLines([error.message]))
      .then(() => {
        if (!closed) {
          redrawInputLine();
        }
      });
  }

  function close() {
    if (closed) {
      return;
    }

    closed = true;
    process.stdin.setRawMode(false);
    process.stdin.off('keypress', onKeypress);
    process.stdout.off('resize', redrawInputBlock);
    clearInputBlock();
    onClose();
  }

  function onKeypress(str, key = {}) {
    if (closed) {
      return;
    }

    if (key.ctrl && key.name === 'c') {
      const now = Date.now();
      if (now - lastInterruptAt < 1500) {
        close();
        return;
      }

      lastInterruptAt = now;
      writeLines(['Press Ctrl+C again to exit DevTalk.']);
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      submitInput();
      return;
    }
    if (key.name === 'backspace') {
      if (cursor > 0) {
        input = input.slice(0, cursor - 1) + input.slice(cursor);
        cursor -= 1;
        redrawInputLine();
      }
      return;
    }
    if (key.name === 'delete') {
      if (cursor < input.length) {
        input = input.slice(0, cursor) + input.slice(cursor + 1);
        redrawInputLine();
      }
      return;
    }
    if (key.name === 'left') {
      if (cursor > 0) {
        cursor -= 1;
        redrawInputLine();
      }
      return;
    }
    if (key.name === 'right') {
      if (cursor < input.length) {
        cursor += 1;
        redrawInputLine();
      }
      return;
    }
    if ((key.ctrl && key.name === 'a') || key.name === 'home') {
      cursor = 0;
      redrawInputLine();
      return;
    }
    if ((key.ctrl && key.name === 'e') || key.name === 'end') {
      cursor = input.length;
      redrawInputLine();
      return;
    }
    if (key.ctrl && key.name === 'u') {
      input = '';
      cursor = 0;
      redrawInputLine();
      return;
    }
    if (key.ctrl || key.meta || !str) {
      return;
    }

    input = input.slice(0, cursor) + str + input.slice(cursor);
    cursor += str.length;
    redrawInputLine();
  }

  process.stdin.on('keypress', onKeypress);
  process.stdout.on('resize', redrawInputBlock);

  return {
    start() {
      drawInputBlock();
    },
    writeLines,
    setPresenceLabel,
    setStatusLineEnabled,
    close
  };
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
  config.colorMode = normalizeColorMode(config.colorMode, true);
  config.statusLine = normalizeColorMode(config.statusLine, true);

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
      },
      presence: {
        key: peerId
      }
    }
  });

  const seen = new Set();
  const speakerColors = new Map();
  let ready = false;
  let ui;

  function writeLines(lines) {
    if (ui) {
      ui.writeLines(lines);
      return;
    }

    for (const line of lines) {
      console.log(line);
    }
  }

  function updateParticipants() {
    const participants = getParticipantsFromPresenceState(channel.presenceState());
    const label = formatPresenceLabel(participants);
    if (ui && typeof ui.setPresenceLabel === 'function') {
      ui.setPresenceLabel(label);
    }
  }

  function trackPresence() {
    channel.track({
      peerId,
      nickname: config.nickname,
      onlineAt: new Date().toISOString()
    });
  }

  channel.on('broadcast', { event: 'message' }, ({ payload }) => {
    if (!payload || typeof payload !== 'object' || payload.kind !== 'devtalk-message' || payload.peerId === peerId) {
      return;
    }
    const id = typeof payload.id === 'string' ? payload.id.slice(0, 128) : '';
    if (id && seen.has(id)) {
      return;
    }
    if (id) {
      seen.add(id);
      if (seen.size > 1024) {
        seen.delete(seen.values().next().value);
      }
    }
    const text = sanitizeTerminalText(payload.text);
    const attachment = sanitizeAttachment(payload.attachment);
    if (!text && !attachment) {
      return;
    }
    writeLines(formatMessage({
      id: id || createId(),
      peerId: typeof payload.peerId === 'string' ? payload.peerId.slice(0, 128) : '',
      nickname: sanitizeTerminalText(payload.nickname, 32) || 'someone',
      text,
      attachment,
      sentAt: Number(payload.sentAt) || Date.now(),
      mine: false
    }, config.theme, { colorMode: config.colorMode, speakerColors }));
  });

  channel.on('presence', { event: 'sync' }, () => {
    updateParticipants();
  });

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      ready = true;
      trackPresence();
      updateParticipants();
      writeLines([
        `Connected to DevTalk room ${ROOM_ID} as ${config.nickname}.`,
        'Type /help for commands.'
      ]);
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      writeLines(['DevTalk connection status: ' + status]);
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
      writeLines(['Message was not sent. Supabase returned: ' + result]);
      return;
    }

    writeLines(formatMessage({ ...message, mine: true }, config.theme, { colorMode: config.colorMode, speakerColors }));
  }

  async function editConfig() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    try {
      await promptConfig(config);
      await saveConfig(config);
      trackPresence();
      updateParticipants();
      writeLines(['Saved DevTalk terminal settings. Restart DevTalk if URL or key changed.']);
    } finally {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
    }
  }

  async function setTheme(value) {
    const nextTheme = value || (config.theme === 'work' ? 'default' : 'work');
    if (!['default', 'work'].includes(nextTheme)) {
      writeLines(['Usage: /theme [default|work]']);
      return;
    }
    config.theme = nextTheme;
    await saveConfig(config);
    writeLines(['Theme changed to ' + nextTheme + '.']);
  }

  async function toggleColorMode(value) {
    if (value) {
      config.colorMode = normalizeColorMode(value, config.colorMode);
    } else {
      config.colorMode = !config.colorMode;
    }

    await saveConfig(config);
    writeLines(['Color mode ' + (config.colorMode ? 'on' : 'off') + '.']);
  }

  async function toggleStatusLine(value) {
    if (value) {
      config.statusLine = normalizeColorMode(value, config.statusLine);
    } else {
      config.statusLine = !config.statusLine;
    }

    await saveConfig(config);
    if (ui && typeof ui.setStatusLineEnabled === 'function') {
      ui.setStatusLineEnabled(config.statusLine);
    }
    writeLines(['Status line ' + (config.statusLine ? 'on' : 'off') + '.']);
  }

  async function sendText(text) {
    const clean = sanitizeTerminalText(text);
    if (!clean) {
      return;
    }
    await publish({
      id: createId(),
      kind: 'devtalk-message',
      peerId,
      nickname: config.nickname,
      text: clean,
      sentAt: Date.now()
    });
  }

  async function sendFile(rawPath) {
    const filePath = path.resolve(rawPath.replace(/^['"]|['"]$/g, ''));
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      writeLines(['Not a file: ' + filePath]);
      return;
    }
    if (stat.size > MAX_FILE_SIZE) {
      writeLines(['Files must be 5 MB or smaller.']);
      return;
    }

    const name = safeFileName(path.basename(filePath));
    const storageName = safeStorageKey(name);
    const type = guessContentType(filePath);
    const objectPath = [
      ROOM_ID,
      new Date().toISOString().slice(0, 10),
      createId() + '-' + storageName
    ].join('/');
    const buffer = await fs.promises.readFile(filePath);

    writeLines(['Uploading ' + name + '...']);
    const { error } = await supabase.storage
      .from(config.bucket)
      .upload(objectPath, buffer, {
        contentType: type,
        upsert: false
      });

    if (error) {
      writeLines(['File upload failed: ' + error.message]);
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

  async function handleLine(line) {
    const text = line.trim();
    if (!text) {
      return;
    }
    if (text === '/quit' || text === '/exit') {
      ui.close();
      return;
    }
    if (text === '/help') {
      writeLines(getHelpLines());
      return;
    }
    if (text === '/config') {
      await editConfig();
      return;
    }
    if (text === '/theme' || text.startsWith('/theme ')) {
      await setTheme(text.slice('/theme'.length).trim());
      return;
    }
    if (text === '/color-mode' || text.startsWith('/color-mode ')) {
      await toggleColorMode(text.slice('/color-mode'.length).trim());
      return;
    }
    if (text === '/status' || text.startsWith('/status ')) {
      await toggleStatusLine(text.slice('/status'.length).trim());
      return;
    }
    if (!ready) {
      writeLines(['DevTalk is still connecting.']);
      return;
    }

    try {
      if (text.startsWith('/file ')) {
        await sendFile(text.slice('/file '.length).trim());
      } else {
        await sendText(text);
      }
    } catch (error) {
      writeLines([error.message]);
    }
  }

  ui = createChatUi({
    onLine: handleLine,
    statusLineEnabled: config.statusLine,
    async onClose() {
      await supabase.removeChannel(channel);
      process.exit(0);
    }
  });
  ui.start();
  updateParticipants();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
