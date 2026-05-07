#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const DEFAULT_BUCKET = 'devtalk-files';
const DEFAULT_ROOM_ID = 'general';
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

function getConfig() {
  return {
    url: getArg('url') || process.env.DEVTALK_SUPABASE_URL || '',
    anonKey: getArg('key') || process.env.DEVTALK_SUPABASE_ANON_KEY || '',
    roomId: getArg('room') || process.env.DEVTALK_ROOM_ID || DEFAULT_ROOM_ID,
    bucket: getArg('bucket') || process.env.DEVTALK_STORAGE_BUCKET || DEFAULT_BUCKET,
    nickname: getArg('name') || process.env.DEVTALK_NICKNAME || os.userInfo().username || os.hostname() || 'terminal'
  };
}

function printHelp() {
  console.log('DevTalk terminal');
  console.log('');
  console.log('Usage: devtalk --url <supabase-url> --key <anon-key> [--room general] [--name you]');
  console.log('');
  console.log('Environment variables:');
  console.log('  DEVTALK_SUPABASE_URL');
  console.log('  DEVTALK_SUPABASE_ANON_KEY');
  console.log('  DEVTALK_ROOM_ID');
  console.log('  DEVTALK_STORAGE_BUCKET');
  console.log('  DEVTALK_NICKNAME');
  console.log('');
  console.log('Commands:');
  console.log('  /file <path>   upload a file up to 5 MB');
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

function renderMessage(message) {
  const who = message.mine ? 'you' : message.nickname || 'someone';
  const text = message.text ? ' ' + message.text : '';
  console.log(`[${formatTime(message.sentAt)}] ${who}:${text}`);

  if (message.attachment) {
    const meta = [message.attachment.type, formatSize(message.attachment.size)].filter(Boolean).join(' · ');
    console.log(`  file: ${message.attachment.name}${meta ? ' (' + meta + ')' : ''}`);
    console.log(`  url: ${message.attachment.url}`);
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const config = getConfig();
  if (!config.url || !config.anonKey) {
    printHelp();
    console.error('\nMissing Supabase URL or anon key.');
    process.exitCode = 1;
    return;
  }

  const supabase = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  const channel = supabase.channel('devtalk:' + config.roomId, {
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
    renderMessage({
      id: payload.id || createId(),
      nickname: String(payload.nickname || 'someone'),
      text: String(payload.text || ''),
      attachment: payload.attachment,
      sentAt: Number(payload.sentAt) || Date.now(),
      mine: false
    });
    rl.prompt();
  });

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      ready = true;
      console.log(`Connected to DevTalk room ${config.roomId} as ${config.nickname}.`);
      console.log('Type /help for commands.');
      rl.prompt();
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      console.error('DevTalk connection status:', status);
    }
  });

  async function publish(message) {
    const result = await channel.send({
      type: 'broadcast',
      event: 'message',
      payload: message
    });

    if (result !== 'ok') {
      console.error('Message was not sent. Supabase returned:', result);
      return;
    }

    renderMessage({ ...message, mine: true });
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
      config.roomId,
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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
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
