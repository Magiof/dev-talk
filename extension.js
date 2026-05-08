const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const DEFAULT_BUCKET = 'devtalk-files';
const ROOM_ID = 'general';
const CONFIG_DIR = path.join(os.homedir(), '.devtalk');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const output = vscode.window.createOutputChannel('DevTalk');
let createSupabaseClient;

function activate(context) {
  log('activate started');

  try {
    const provider = new DevTalkViewProvider(context);
    log('registering webview provider: devtalkView');
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('devtalkView', provider)
    );
    context.subscriptions.push(output);
    log('webview provider registered');
  } catch (error) {
    logError('activate failed', error);
    throw error;
  }
}

function deactivate() {
  log('deactivate');
}

function log(message) {
  const timestamp = new Date().toISOString();
  output.appendLine('[' + timestamp + '] ' + message);
}

function logError(message, error) {
  const detail = error && error.stack ? error.stack : String(error && error.message ? error.message : error);
  log(message + ': ' + detail);
}

function createId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function getCreateSupabaseClient() {
  if (createSupabaseClient) {
    return createSupabaseClient;
  }

  const WebSocket = require('ws');
  if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = WebSocket;
  }

  createSupabaseClient = require('@supabase/supabase-js').createClient;
  return createSupabaseClient;
}

class DevTalkViewProvider {
  constructor(context) {
    log('provider constructor started');
    this.context = context;
    this.peerId = createId();
    this.webviewView = undefined;
    this.supabase = undefined;
    this.channel = undefined;
    this.messages = [];
    this.participants = [];
    this.seenMessageIds = new Set();
    this.unreadCount = 0;
    this.unreadStartMessageId = undefined;
    this.readMarkerMessageId = undefined;
    this.status = 'Ready to join DevTalk.';
    this.nickname = getNickname(context);
    this.config = getSupabaseConfig();
    this.promptingConfig = false;
    this.joined = false;
    this.connected = false;

    if (!this.nickname) {
      this.status = 'Enter your name to start.';
    } else if (!this.config.ready) {
      this.status = this.config.message;
    }
    log('provider constructor finished: nickname=' + Boolean(this.nickname) + ', configReady=' + Boolean(this.config.ready));
  }

  resolveWebviewView(webviewView) {
    log('resolveWebviewView started');
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = getFallbackHtml('Loading DevTalk...');

    try {
      log('getWebviewHtml started');
      webviewView.webview.html = getWebviewHtml(webviewView.webview);
      log('getWebviewHtml finished');
    } catch (error) {
      logError('getWebviewHtml failed', error);
      this.status = 'DevTalk view failed to load: ' + error.message;
      webviewView.webview.html = getFallbackHtml(this.status);
      return;
    }

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.markRead();
      }
    });

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.type === 'setNickname' && typeof message.nickname === 'string') {
        this.setNickname(message.nickname);
      }
      if (message.type === 'join') {
        this.joinChat().catch((error) => {
          logError('join failed', error);
          this.status = 'DevTalk join failed: ' + error.message;
          this.postState();
        });
      }
      if (message.type === 'leave') {
        this.leaveChat().catch((error) => {
          logError('leave failed', error);
          this.status = 'DevTalk leave failed: ' + error.message;
          this.postState();
        });
      }
      if (message.type === 'send' && typeof message.text === 'string') {
        this.sendChat(message.text);
      }
      if (message.type === 'uploadFile' && message.file) {
        this.uploadFile(message.file);
      }
      if (message.type === 'openExternal' && typeof message.url === 'string') {
        vscode.env.openExternal(vscode.Uri.parse(message.url));
      }
      if (message.type === 'ready') {
        if (this.isViewVisible()) {
          this.markRead();
          return;
        }
        this.postState();
      }
    });

    try {
      this.updateBadge();
      this.postState();
      setTimeout(() => {
        log('deferred initializeView scheduled');
        this.postState();
        this.initializeView();
      }, 0);
    } catch (error) {
      logError('resolveWebviewView failed', error);
      this.status = 'DevTalk initialization failed: ' + error.message;
      webviewView.webview.html = getFallbackHtml(this.status);
    }
  }

  initializeView() {
    log('initializeView started');
    this.reloadSettings();
    this.postState();
    log('initializeView finished');
  }

  reloadSettings() {
    this.nickname = getNickname(this.context);
    this.config = getSupabaseConfig();
    if (!this.nickname) {
      this.status = 'Enter your name to start.';
    } else if (!this.config.ready) {
      this.status = this.config.message;
    } else if (!this.joined) {
      this.status = 'Ready to join DevTalk.';
    }
  }

  isViewVisible() {
    return Boolean(this.webviewView && this.webviewView.visible);
  }

  markRead() {
    if (this.unreadCount > 0) {
      this.readMarkerMessageId = this.unreadStartMessageId;
      this.unreadCount = 0;
      this.unreadStartMessageId = undefined;
      this.updateBadge();
    }
    this.postState();
  }

  updateBadge() {
    if (!this.webviewView) {
      return;
    }

    const badgeValue = Math.min(this.unreadCount, 999);

    try {
      this.webviewView.badge = this.unreadCount > 0
        ? {
            value: badgeValue,
            tooltip: this.unreadCount === 1 ? '1 unread message' : this.unreadCount + ' unread messages'
          }
        : undefined;
    } catch {
      // Some VS Code-compatible hosts may not support view badges yet.
    }
  }

  connect() {
    log('connect started');
    if (!this.nickname) {
      log('connect skipped: nickname missing');
      return;
    }

    this.config = getSupabaseConfig();
    if (!this.config.ready) {
      this.status = this.config.message;
      this.postState();
      log('connect skipped: config missing');
      return;
    }

    if (this.channel) {
      log('connect skipped: channel already exists');
      return;
    }

    this.joined = true;

    let createClient;
    try {
      createClient = getCreateSupabaseClient();
    } catch (error) {
      logError('Supabase dependency load failed', error);
      this.status = 'DevTalk extension dependency failed to load: ' + error.message;
      this.postState();
      return;
    }

    this.supabase = createClient(this.config.url, this.config.anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });

    this.channel = this.supabase.channel('devtalk:' + ROOM_ID, {
      config: {
        broadcast: {
          self: false
        },
        presence: {
          key: this.peerId
        }
      }
    });

    this.channel.on('broadcast', { event: 'message' }, ({ payload }) => {
      this.receiveMessage(payload);
    });

    this.channel.on('presence', { event: 'sync' }, () => {
      this.updateParticipants();
    });

    this.channel.subscribe((status) => {
      log('Supabase channel status: ' + status);
      if (!this.joined && status !== 'SUBSCRIBED') {
        return;
      }
      if (status === 'SUBSCRIBED') {
        this.connected = true;
        this.status = 'Connected to DevTalk room ' + ROOM_ID;
        this.trackPresence();
        this.updateParticipants();
      } else if (status === 'CHANNEL_ERROR') {
        this.connected = false;
        this.status = 'DevTalk connection failed. Check Supabase settings.';
      } else if (status === 'TIMED_OUT') {
        this.connected = false;
        this.status = 'DevTalk connection timed out.';
      } else if (status === 'CLOSED') {
        this.connected = false;
        this.status = 'DevTalk connection closed.';
      } else {
        this.connected = false;
        this.status = 'Connecting to DevTalk...';
      }
      this.postState();
    });
  }

  trackPresence() {
    if (!this.channel || !this.nickname) {
      return;
    }

    this.channel.track({
      peerId: this.peerId,
      nickname: this.nickname,
      onlineAt: new Date().toISOString()
    });
  }

  updateParticipants() {
    if (!this.channel) {
      this.participants = [];
      this.postState();
      return;
    }

    this.participants = getParticipantsFromPresenceState(this.channel.presenceState(), this.peerId);
    this.postState();
  }

  setNickname(rawNickname) {
    const nickname = rawNickname.trim().slice(0, 32);
    if (!nickname) {
      return;
    }

    this.nickname = nickname;
    this.context.globalState.update('nickname', nickname);
    updateSharedConfig({ nickname }).catch(() => {});
    this.status = 'Joining DevTalk...';
    this.joinChat().catch((error) => {
      logError('join after nickname failed', error);
      this.status = 'DevTalk join failed: ' + error.message;
      this.postState();
    });
    this.postState();
  }

  async joinChat() {
    this.reloadSettings();
    if (!this.nickname) {
      this.status = 'Enter your name to start.';
      this.postState();
      return;
    }

    if (!hasSharedConfig()) {
      log('shared config missing, prompting setup before join');
      const configured = await this.ensureSharedConfig();
      if (!configured) {
        log('join canceled during setup');
        this.joined = false;
        return;
      }
    }

    this.reloadSettings();
    if (!this.config.ready) {
      this.joined = false;
      this.status = this.config.message;
      this.postState();
      return;
    }

    if (this.channel) {
      this.joined = true;
      this.status = this.connected ? 'Connected to DevTalk room ' + ROOM_ID : 'Connecting to DevTalk...';
      this.trackPresence();
      this.updateParticipants();
      this.postState();
      return;
    }

    this.joined = true;
    this.status = 'Connecting to DevTalk...';
    this.postState();
    this.connect();
  }

  async leaveChat() {
    log('leaveChat started');
    this.joined = false;
    if (this.channel && this.supabase) {
      await this.supabase.removeChannel(this.channel);
    }
    this.channel = undefined;
    this.supabase = undefined;
    this.connected = false;
    this.participants = [];
    this.status = 'Left DevTalk. Join when you are ready.';
    this.postState();
    log('leaveChat finished');
  }

  async ensureSharedConfig() {
    if (this.promptingConfig || hasSharedConfig()) {
      return true;
    }

    this.promptingConfig = true;
    this.status = 'DevTalk setup required.';
    this.postState();

    try {
      const configured = await this.configureSettings({
        titlePrefix: 'DevTalk first setup',
        successMessage: 'DevTalk terminal config saved.'
      });
      if (!configured) {
        this.status = 'DevTalk setup was canceled. Run /config or reopen DevTalk to set it up.';
        this.postState();
      }
      return configured;
    } finally {
      this.promptingConfig = false;
    }
  }

  async sendChat(rawText) {
    const text = rawText.trim();
    if (!text) {
      return;
    }
    if (text.startsWith('/')) {
      await this.handleCommand(text);
      return;
    }
    if (!this.canSend()) {
      this.status = this.joined && this.config.ready
        ? 'DevTalk is still connecting.'
        : this.config.ready
          ? 'Join DevTalk to send messages.'
          : this.config.message;
      this.postState();
      return;
    }

    await this.publishMessage({
      id: createId(),
      kind: 'devtalk-message',
      peerId: this.peerId,
      nickname: this.nickname,
      text,
      sentAt: Date.now()
    });
  }

  async handleCommand(text) {
    const [command, ...args] = text.slice(1).split(/\s+/);
    const value = args.join(' ').trim();

    if (command === 'theme') {
      await this.setThemeCommand(value);
      return;
    }
    if (command === 'color-mode') {
      await this.setColorModeCommand(value);
      return;
    }
    if (command === 'config') {
      await this.configureSettings();
      return;
    }
    if (command === 'help') {
      this.status = 'Commands: /theme [default|work], /color-mode, /config';
      this.postState();
      return;
    }

    this.status = 'Unknown command: /' + command;
    this.postState();
  }

  async setThemeCommand(value) {
    const current = getTheme();
    const nextTheme = value || (current === 'work' ? 'default' : 'work');
    if (!['default', 'work'].includes(nextTheme)) {
      this.status = 'Usage: /theme [default|work]';
      this.postState();
      return;
    }

    await vscode.workspace
      .getConfiguration('devtalk')
      .update('theme', nextTheme, vscode.ConfigurationTarget.Global);
    await updateSharedConfig({ theme: nextTheme });
    this.status = 'Theme changed to ' + nextTheme + '.';
    this.postState();
  }

  async setColorModeCommand(value) {
    const current = getColorMode();
    const nextValue = value ? normalizeColorMode(value, current) : !current;

    await vscode.workspace
      .getConfiguration('devtalk')
      .update('colorMode', nextValue, vscode.ConfigurationTarget.Global);
    await updateSharedConfig({ colorMode: nextValue });
    this.status = 'Color mode ' + (nextValue ? 'on' : 'off') + '.';
    this.postState();
  }

  async configureSettings(options = {}) {
    const config = vscode.workspace.getConfiguration('devtalk');
    const current = getSupabaseConfig();
    const nickname = await vscode.window.showInputBox({
      title: options.titlePrefix ? options.titlePrefix + ': nickname' : 'DevTalk nickname',
      value: this.nickname || '',
      prompt: 'Shown to other people in DevTalk.'
    });
    if (nickname === undefined) {
      return false;
    }

    const supabaseUrl = await vscode.window.showInputBox({
      title: options.titlePrefix ? options.titlePrefix + ': Supabase URL' : 'DevTalk Supabase URL',
      value: current.url || '',
      prompt: 'Example: https://your-project.supabase.co'
    });
    if (supabaseUrl === undefined) {
      return false;
    }

    const anonKey = await vscode.window.showInputBox({
      title: options.titlePrefix ? options.titlePrefix + ': Supabase anon key' : 'DevTalk Supabase anon key',
      value: current.anonKey || '',
      password: true,
      prompt: 'Use anon/publishable key only. Never use service role key.'
    });
    if (anonKey === undefined) {
      return false;
    }

    const bucket = await vscode.window.showInputBox({
      title: options.titlePrefix ? options.titlePrefix + ': Storage bucket' : 'DevTalk Storage bucket',
      value: current.bucket || DEFAULT_BUCKET,
      prompt: 'Supabase Storage bucket for files and images.'
    });
    if (bucket === undefined) {
      return false;
    }

    const cleanNickname = nickname.trim().slice(0, 32);
    if (cleanNickname) {
      this.nickname = cleanNickname;
      await this.context.globalState.update('nickname', cleanNickname);
    }

    await config.update('supabaseUrl', supabaseUrl.trim(), vscode.ConfigurationTarget.Global);
    await config.update('supabaseAnonKey', anonKey.trim(), vscode.ConfigurationTarget.Global);
    await config.update('storageBucket', bucket.trim() || DEFAULT_BUCKET, vscode.ConfigurationTarget.Global);
    await saveSharedConfig({
      url: supabaseUrl.trim(),
      anonKey: anonKey.trim(),
      bucket: bucket.trim() || DEFAULT_BUCKET,
      nickname: cleanNickname || this.nickname || '',
      theme: getTheme(),
      colorMode: getColorMode()
    });

    await this.reconnect();
    if (this.joined) {
      this.trackPresence();
    }
    this.status = options.successMessage || (this.joined ? 'DevTalk configuration updated.' : 'DevTalk configuration updated. Join when you are ready.');
    this.postState();
    return true;
  }

  async reconnect() {
    if (this.channel && this.supabase) {
      await this.supabase.removeChannel(this.channel);
    }
    this.channel = undefined;
    this.supabase = undefined;
    this.connected = false;
    this.participants = [];
    this.config = getSupabaseConfig();
    if (this.joined) {
      this.connect();
    }
  }

  async uploadFile(file) {
    if (!this.canSend()) {
      this.status = this.joined && this.config.ready
        ? 'DevTalk is still connecting.'
        : this.config.ready
          ? 'Join DevTalk to send files.'
          : this.config.message;
      this.postState();
      return;
    }

    const name = safeFileName(String(file.name || 'file'));
    const type = String(file.type || 'application/octet-stream');
    const size = Number(file.size || 0);
    const data = String(file.data || '');

    if (!name || !data) {
      return;
    }
    if (size > MAX_FILE_SIZE) {
      this.status = 'Files must be 5 MB or smaller.';
      this.postState();
      return;
    }

    const buffer = Buffer.from(data, 'base64');
    if (buffer.byteLength > MAX_FILE_SIZE) {
      this.status = 'Files must be 5 MB or smaller.';
      this.postState();
      return;
    }

    const objectPath = [
      ROOM_ID,
      new Date().toISOString().slice(0, 10),
      createId() + '-' + name
    ].join('/');

    this.status = 'Uploading ' + name + '...';
    this.postState();

    const { error } = await this.supabase.storage
      .from(this.config.bucket)
      .upload(objectPath, buffer, {
        contentType: type,
        upsert: false
      });

    if (error) {
      this.status = 'File upload failed: ' + error.message;
      this.postState();
      return;
    }

    const { data: publicUrlData } = this.supabase.storage
      .from(this.config.bucket)
      .getPublicUrl(objectPath);

    await this.publishMessage({
      id: createId(),
      kind: 'devtalk-message',
      peerId: this.peerId,
      nickname: this.nickname,
      text: '',
      attachment: {
        name,
        type,
        size: buffer.byteLength,
        url: publicUrlData.publicUrl,
        path: objectPath,
        isImage: type.startsWith('image/')
      },
      sentAt: Date.now()
    });
  }

  async publishMessage(message) {
    const result = await this.channel.send({
      type: 'broadcast',
      event: 'message',
      payload: message
    });

    if (result !== 'ok') {
      this.status = 'Message was not sent. Check Supabase Realtime settings.';
      this.postState();
      return;
    }

    this.addMessage({ ...message, mine: true });
    this.status = 'Connected to DevTalk room ' + ROOM_ID;
  }

  receiveMessage(payload) {
    if (!payload || payload.kind !== 'devtalk-message') {
      return;
    }
    if (payload.peerId === this.peerId) {
      return;
    }

    const messageId = String(payload.id || '');
    if (messageId && this.seenMessageIds.has(messageId)) {
      return;
    }
    if (messageId) {
      this.seenMessageIds.add(messageId);
    }

    this.addMessage({
      id: payload.id || createId(),
      text: String(payload.text || ''),
      nickname: String(payload.nickname || 'Someone'),
      peerId: String(payload.peerId || ''),
      attachment: normalizeAttachment(payload.attachment),
      mine: false,
      sentAt: Number(payload.sentAt) || Date.now()
    });
  }

  addMessage(message) {
    this.messages.push(message);

    if (!message.mine && !this.isViewVisible()) {
      if (this.unreadCount === 0) {
        this.unreadStartMessageId = message.id;
      }
      this.unreadCount += 1;
    }

    if (this.messages.length > 200) {
      const removed = this.messages.shift();
      if (removed && removed.id === this.readMarkerMessageId) {
        this.readMarkerMessageId = undefined;
      }
      if (removed && removed.id === this.unreadStartMessageId) {
        this.unreadStartMessageId = this.messages.find((item) => !item.mine)?.id;
      }
    }

    this.updateBadge();
    this.postState();
  }

  canSend() {
    return Boolean(this.joined && this.connected && this.nickname && this.channel && this.config.ready);
  }

  postState() {
    if (!this.webviewView) {
      return;
    }

    this.webviewView.webview.postMessage({
      type: 'state',
      nickname: this.nickname,
      status: this.status,
      needsNickname: !this.nickname,
      joined: this.joined,
      canSend: this.canSend(),
      maxFileSize: MAX_FILE_SIZE,
      theme: getTheme(),
      colorMode: getColorMode(),
      participants: this.participants,
      unreadCount: this.unreadCount,
      readMarkerMessageId: this.readMarkerMessageId,
      messages: this.messages
    });
  }
}

function getNickname(context) {
  const configuredName = getConfiguredString('nickname');
  const saved = context.globalState.get('nickname', '');
  const savedName = typeof saved === 'string' ? saved.trim() : '';
  const shared = loadSharedConfig();
  const sharedName = typeof shared.nickname === 'string' ? shared.nickname.trim() : '';

  return configuredName || savedName || sharedName;
}

function getTheme() {
  const shared = loadSharedConfig();
  const theme = getConfiguredString('theme') || shared.theme || 'default';

  return theme === 'work' ? 'work' : 'default';
}

function getColorMode() {
  const shared = loadSharedConfig();
  const configured = getConfiguredValue('colorMode');
  return normalizeColorMode(configured === undefined ? shared.colorMode : configured, true);
}

function normalizeColorMode(value, defaultValue = true) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'color', 'colors'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off', 'plain'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function getSupabaseConfig() {
  const shared = loadSharedConfig();
  const url = (getConfiguredString('supabaseUrl') || String(shared.url || '')).trim();
  const anonKey = (getConfiguredString('supabaseAnonKey') || String(shared.anonKey || '')).trim();
  const bucket = (getConfiguredString('storageBucket') || String(shared.bucket || DEFAULT_BUCKET)).trim();

  if (!url || !anonKey) {
    return {
      ready: false,
      message: 'Set devtalk.supabaseUrl and devtalk.supabaseAnonKey to start.',
      url,
      anonKey,
      bucket
    };
  }

  return {
    ready: true,
    message: '',
    url,
    anonKey,
    bucket: bucket || DEFAULT_BUCKET
  };
}

function getConfiguredString(key) {
  const value = getConfiguredValue(key);
  return typeof value === 'string' ? value.trim() : '';
}

function getConfiguredValue(key) {
  const inspected = vscode.workspace
    .getConfiguration('devtalk')
    .inspect(key);

  if (!inspected) {
    return undefined;
  }

  if (inspected.workspaceFolderValue !== undefined) return inspected.workspaceFolderValue;
  if (inspected.workspaceValue !== undefined) return inspected.workspaceValue;
  if (inspected.globalValue !== undefined) return inspected.globalValue;
  return undefined;
}

function loadSharedConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

function hasSharedConfig() {
  const config = loadSharedConfig();
  return Boolean(
    typeof config.url === 'string' &&
    config.url.trim() &&
    typeof config.anonKey === 'string' &&
    config.anonKey.trim()
  );
}

async function saveSharedConfig(config) {
  await fs.promises.mkdir(CONFIG_DIR, { mode: 0o700, recursive: true });
  await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

async function updateSharedConfig(patch) {
  const current = loadSharedConfig();
  await saveSharedConfig({
    ...current,
    ...patch
  });
}

function safeFileName(name) {
  const cleaned = name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.slice(0, 120) || 'file';
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') {
    return undefined;
  }

  const url = String(attachment.url || '');
  if (!url) {
    return undefined;
  }

  const type = String(attachment.type || 'application/octet-stream');
  return {
    name: String(attachment.name || 'file'),
    type,
    size: Number(attachment.size || 0),
    url,
    path: String(attachment.path || ''),
    isImage: Boolean(attachment.isImage || type.startsWith('image/'))
  };
}

function getParticipantsFromPresenceState(state, currentPeerId) {
  const participants = [];

  for (const [key, entries] of Object.entries(state || {})) {
    const entry = Array.isArray(entries) ? entries[entries.length - 1] : undefined;
    if (!entry) {
      continue;
    }

    const peerId = String(entry.peerId || key);
    const nickname = String(entry.nickname || 'Someone').trim() || 'Someone';
    participants.push({
      peerId,
      nickname,
      mine: peerId === currentPeerId
    });
  }

  return participants.sort((a, b) => {
    if (a.mine) return -1;
    if (b.mine) return 1;
    return a.nickname.localeCompare(b.nickname);
  });
}

function getFallbackHtml(message) {
  const escaped = String(message || 'Loading DevTalk...')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .title { font-weight: 600; margin-bottom: 6px; }
    .status { color: var(--vscode-descriptionForeground); line-height: 1.45; }
  </style>
</head>
<body>
  <div class="title">DevTalk</div>
  <div class="status">${escaped}</div>
</body>
</html>`;
}

function getWebviewHtml(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DevTalk</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .setup {
      display: grid;
      align-content: center;
      gap: 10px;
      height: 100vh;
      padding: 14px;
    }
    .setup[hidden], .chat[hidden] { display: none; }
    .setup-title { font-size: 13px; font-weight: 600; line-height: 1.35; }
    .setup-help { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; }
    .setup-form { display: grid; gap: 8px; }
    .chat {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100vh;
      min-height: 180px;
    }
    .header {
      padding: 10px 10px 8px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }
    .header-top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
      gap: 8px;
    }
    .title { font-size: 12px; font-weight: 600; line-height: 1.3; }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      justify-self: end;
      min-width: 0;
    }
    .presence {
      max-width: 92px;
      padding: 2px 6px;
      border-radius: 999px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 10px;
      line-height: 1.25;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status {
      margin-top: 3px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .messages { min-height: 0; overflow-y: auto; padding: 10px; }
    .empty { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; padding-top: 4px; }
    .read-marker {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 8px;
      margin: 4px 0 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.2;
    }
    .read-marker::before, .read-marker::after {
      content: '';
      height: 1px;
      background: var(--vscode-panel-border);
    }
    .message {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 3px;
      margin-bottom: 10px;
    }
    .message.mine { align-items: flex-end; }
    .meta {
      max-width: 86%;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bubble {
      --speaker-bg: color-mix(in srgb, var(--vscode-input-background) 92%, transparent);
      --speaker-border: var(--vscode-input-border, transparent);
      max-width: 86%;
      padding: 7px 9px;
      border: 1px solid var(--speaker-border);
      border-radius: 8px;
      background: var(--speaker-bg);
      color: var(--vscode-input-foreground);
      line-height: 1.4;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      box-shadow: inset 4px 0 0 var(--speaker-border);
    }
    .mine .bubble {
      color: var(--vscode-input-foreground);
      box-shadow: inset -4px 0 0 var(--speaker-border);
    }
    .attachment {
      display: grid;
      gap: 6px;
      max-width: 100%;
    }
    .attachment img {
      display: block;
      max-width: 100%;
      max-height: 220px;
      border-radius: 6px;
      object-fit: contain;
    }
    .file-link {
      color: inherit;
      text-decoration: underline;
      text-underline-offset: 2px;
      cursor: pointer;
    }
    .file-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    .composer {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 6px;
      padding: 8px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      background: var(--vscode-sideBar-background);
    }
    input, textarea {
      width: 100%;
      min-width: 0;
      height: 34px;
      max-height: 90px;
      resize: vertical;
      padding: 7px 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      outline: none;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-family: inherit;
      font-size: inherit;
      line-height: 1.35;
    }
    input:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
    button {
      min-width: 36px;
      height: 34px;
      padding: 0 10px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .secondary-button {
      min-width: 0;
      height: 22px;
      padding: 0 7px;
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      font-size: 10px;
      line-height: 20px;
    }
    .secondary-button:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    .secondary-button[hidden] { display: none; }
    .file-input { display: none; }

    body.theme-work {
      font-size: calc(var(--vscode-font-size) - 1px);
    }
    .theme-work .header { padding: 7px 9px 6px; }
    .theme-work .title { font-size: 11px; font-weight: 500; }
    .theme-work .presence {
      padding: 1px 5px;
      font-size: 9px;
    }
    .theme-work .secondary-button {
      height: 20px;
      padding: 0 6px;
      font-size: 9px;
      line-height: 18px;
    }
    .theme-work .status { font-size: 10px; }
    .theme-work .messages { padding: 6px 8px; }
    .theme-work .message,
    .theme-work .message.mine {
      align-items: stretch;
      gap: 1px;
      margin-bottom: 5px;
    }
    .theme-work .meta {
      max-width: 100%;
      font-size: 9px;
    }
    .theme-work .bubble {
      max-width: 100%;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--vscode-foreground);
      line-height: 1.28;
      box-shadow: none;
    }
    .theme-work .mine .bubble {
      background: transparent;
      color: var(--vscode-foreground);
      border-color: transparent;
      box-shadow: none;
    }
    .color-mode.theme-work .bubble {
      padding: 2px 5px;
      border: 0;
      border-left: 3px solid var(--speaker-border);
      background: var(--speaker-bg);
      color: var(--vscode-foreground);
      box-shadow: none;
    }
    .color-mode.theme-work .mine .bubble {
      border-left: 0;
      border-right: 3px solid var(--speaker-border);
      background: var(--speaker-bg);
      color: var(--vscode-foreground);
      box-shadow: none;
    }
    .theme-work .attachment { gap: 3px; }
    .theme-work .attachment img {
      max-height: 140px;
      border-radius: 2px;
    }
    .theme-work .file-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .theme-work .file-meta { font-size: 9px; }
    .theme-work .composer {
      gap: 4px;
      padding: 6px;
    }
    .theme-work input,
    .theme-work textarea {
      height: 28px;
      padding: 5px 6px;
      font-size: calc(var(--vscode-font-size) - 1px);
    }
    .theme-work button {
      min-width: 30px;
      height: 28px;
      padding: 0 7px;
      font-size: 10px;
    }
  </style>
</head>
<body>
  <section id="setup" class="setup" hidden>
    <div class="setup-title">Choose your chat name</div>
    <div class="setup-help">This name is shown to people in DevTalk.</div>
    <form id="setupForm" class="setup-form">
      <input id="nicknameInput" type="text" maxlength="32" autocomplete="off" placeholder="Name" />
      <button type="submit">Start Chat</button>
    </form>
  </section>
  <main id="chat" class="chat">
    <header class="header">
      <div class="header-top">
        <div class="title">DevTalk</div>
        <div class="header-actions">
          <div id="presence" class="presence" title="Online">0 online</div>
          <button id="joinButton" class="secondary-button" type="button">Join</button>
          <button id="leaveButton" class="secondary-button" type="button" hidden>Leave</button>
        </div>
      </div>
      <div id="status" class="status">Connecting...</div>
    </header>
    <section id="messages" class="messages" aria-live="polite"></section>
    <form id="composer" class="composer">
      <button id="attachButton" type="button" title="Attach file">+</button>
      <textarea id="input" rows="1" placeholder="Message"></textarea>
      <button id="sendButton" type="submit">Send</button>
      <input id="fileInput" class="file-input" type="file" />
    </form>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const setupEl = document.getElementById('setup');
    const chatEl = document.getElementById('chat');
    const setupForm = document.getElementById('setupForm');
    const nicknameInput = document.getElementById('nicknameInput');
    const messagesEl = document.getElementById('messages');
    const statusEl = document.getElementById('status');
    const presenceEl = document.getElementById('presence');
    const joinButton = document.getElementById('joinButton');
    const leaveButton = document.getElementById('leaveButton');
    const form = document.getElementById('composer');
    const input = document.getElementById('input');
    const sendButton = document.getElementById('sendButton');
    const attachButton = document.getElementById('attachButton');
    const fileInput = document.getElementById('fileInput');
    const speakerPalette = [
      ['rgb(255 226 230 / 0.56)', 'rgb(248 134 149 / 0.82)'],
      ['rgb(255 239 199 / 0.58)', 'rgb(235 174 77 / 0.82)'],
      ['rgb(242 245 181 / 0.58)', 'rgb(185 191 73 / 0.82)'],
      ['rgb(213 245 204 / 0.56)', 'rgb(117 195 93 / 0.82)'],
      ['rgb(201 244 232 / 0.56)', 'rgb(83 190 161 / 0.82)'],
      ['rgb(199 235 255 / 0.56)', 'rgb(75 166 215 / 0.82)'],
      ['rgb(218 224 255 / 0.56)', 'rgb(122 139 222 / 0.82)'],
      ['rgb(236 218 255 / 0.56)', 'rgb(165 117 222 / 0.82)'],
      ['rgb(255 218 242 / 0.56)', 'rgb(221 115 184 / 0.82)'],
      ['rgb(224 224 224 / 0.56)', 'rgb(153 153 153 / 0.82)']
    ];
    let isComposing = false;
    let maxFileSize = ${MAX_FILE_SIZE};

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

    function speakerKey(message, state) {
      return message.peerId || message.nickname || (message.mine ? state.nickname : 'someone');
    }

    function speakerColors(message, state, speakerMap) {
      const key = speakerKey(message, state);
      if (!speakerMap.has(key)) {
        speakerMap.set(key, speakerMap.size % speakerPalette.length);
      }

      const colors = speakerPalette[speakerMap.get(key)];
      return {
        background: colors[0],
        border: colors[1]
      };
    }

    function renderAttachment(attachment) {
      const wrap = document.createElement('div');
      wrap.className = 'attachment';

      if (attachment.isImage) {
        const image = document.createElement('img');
        image.src = attachment.url;
        image.alt = attachment.name;
        wrap.appendChild(image);
      }

      const link = document.createElement('a');
      link.className = 'file-link';
      link.href = attachment.url;
      link.textContent = attachment.name;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        vscode.postMessage({ type: 'openExternal', url: attachment.url });
      });
      wrap.appendChild(link);

      const meta = document.createElement('div');
      meta.className = 'file-meta';
      meta.textContent = [attachment.type, formatSize(attachment.size)].filter(Boolean).join(' · ');
      wrap.appendChild(meta);

      return wrap;
    }

    function render(state) {
      maxFileSize = state.maxFileSize || maxFileSize;
      document.body.classList.toggle('theme-work', state.theme === 'work');
      document.body.classList.toggle('color-mode', Boolean(state.colorMode));

      if (state.needsNickname) {
        setupEl.hidden = false;
        chatEl.hidden = true;
        nicknameInput.focus();
        return;
      }

      setupEl.hidden = true;
      chatEl.hidden = false;
      statusEl.textContent = state.status || '';
      const participants = Array.isArray(state.participants) ? state.participants : [];
      const names = participants.map((item) => item.mine ? 'You' : item.nickname).filter(Boolean);
      presenceEl.textContent = participants.length + ' online';
      presenceEl.title = names.length ? 'Online: ' + names.join(', ') : 'No one online';
      joinButton.hidden = Boolean(state.joined);
      leaveButton.hidden = !state.joined;
      joinButton.disabled = !state.nickname;
      input.disabled = !state.canSend;
      sendButton.disabled = !state.canSend;
      attachButton.disabled = !state.canSend;
      messagesEl.textContent = '';

      if (!state.messages || state.messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Messages will appear here once DevTalk is connected.';
        messagesEl.appendChild(empty);
        return;
      }

      const speakerMap = new Map();

      for (const message of state.messages) {
        if (message.id === state.readMarkerMessageId) {
          const marker = document.createElement('div');
          marker.className = 'read-marker';
          marker.textContent = 'Unread messages';
          messagesEl.appendChild(marker);
        }

        const item = document.createElement('article');
        item.className = 'message' + (message.mine ? ' mine' : '');

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = (message.mine ? 'You' : message.nickname) + ' · ' + formatTime(message.sentAt);

        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        if (state.colorMode) {
          const colors = speakerColors(message, state, speakerMap);
          bubble.style.setProperty('--speaker-bg', colors.background);
          bubble.style.setProperty('--speaker-border', colors.border);
        }
        if (message.text) {
          const text = document.createElement('div');
          text.textContent = message.text;
          bubble.appendChild(text);
        }
        if (message.attachment) {
          bubble.appendChild(renderAttachment(message.attachment));
        }

        item.append(meta, bubble);
        messagesEl.appendChild(item);
      }

      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          resolve(result.includes(',') ? result.split(',')[1] : result);
        };
        reader.onerror = () => reject(reader.error || new Error('File read failed'));
        reader.readAsDataURL(file);
      });
    }

    setupForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const nickname = nicknameInput.value.trim();
      if (!nickname) {
        nicknameInput.focus();
        return;
      }
      vscode.postMessage({ type: 'setNickname', nickname });
    });

    joinButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'join' });
    });

    leaveButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'leave' });
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value;
      if (!text.trim()) {
        return;
      }
      vscode.postMessage({ type: 'send', text });
      input.value = '';
      input.focus();
    });

    attachButton.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) {
        return;
      }
      if (file.size > maxFileSize) {
        statusEl.textContent = 'Files must be 5 MB or smaller.';
        return;
      }

      const data = await readFileAsBase64(file);
      vscode.postMessage({
        type: 'uploadFile',
        file: {
          name: file.name,
          type: file.type,
          size: file.size,
          data
        }
      });
    });

    input.addEventListener('compositionstart', () => {
      isComposing = true;
    });

    input.addEventListener('compositionend', () => {
      isComposing = false;
    });

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      if (isComposing || event.isComposing || event.keyCode === 229) {
        return;
      }
      event.preventDefault();
      form.requestSubmit();
    });

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'state') {
        render(event.data);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

module.exports = {
  activate,
  deactivate
};
