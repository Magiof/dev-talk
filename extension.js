const vscode = require('vscode');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const DEFAULT_BUCKET = 'devtalk-files';
const DEFAULT_ROOM_ID = 'general';

function activate(context) {
  const provider = new DevTalkViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('devtalkView', provider)
  );
}

function deactivate() {}

function createId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

class DevTalkViewProvider {
  constructor(context) {
    this.context = context;
    this.peerId = createId();
    this.webviewView = undefined;
    this.supabase = undefined;
    this.channel = undefined;
    this.messages = [];
    this.seenMessageIds = new Set();
    this.unreadCount = 0;
    this.unreadStartMessageId = undefined;
    this.readMarkerMessageId = undefined;
    this.status = 'Connecting to DevTalk...';
    this.nickname = getNickname(context);
    this.config = getSupabaseConfig();

    if (!this.nickname) {
      this.status = 'Enter your name to start.';
    } else if (!this.config.ready) {
      this.status = this.config.message;
    }
  }

  resolveWebviewView(webviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = getWebviewHtml(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.markRead();
      }
    });

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.type === 'setNickname' && typeof message.nickname === 'string') {
        this.setNickname(message.nickname);
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

    this.connect();
    this.updateBadge();
    this.postState();
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
    if (!this.nickname) {
      return;
    }

    this.config = getSupabaseConfig();
    if (!this.config.ready) {
      this.status = this.config.message;
      this.postState();
      return;
    }

    if (this.channel) {
      return;
    }

    this.supabase = createClient(this.config.url, this.config.anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });

    this.channel = this.supabase.channel('devtalk:' + this.config.roomId, {
      config: {
        broadcast: {
          self: false
        }
      }
    });

    this.channel.on('broadcast', { event: 'message' }, ({ payload }) => {
      this.receiveMessage(payload);
    });

    this.channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        this.status = 'Connected to DevTalk room ' + this.config.roomId;
      } else if (status === 'CHANNEL_ERROR') {
        this.status = 'DevTalk connection failed. Check Supabase settings.';
      } else if (status === 'TIMED_OUT') {
        this.status = 'DevTalk connection timed out.';
      } else if (status === 'CLOSED') {
        this.status = 'DevTalk connection closed.';
      } else {
        this.status = 'Connecting to DevTalk...';
      }
      this.postState();
    });
  }

  setNickname(rawNickname) {
    const nickname = rawNickname.trim().slice(0, 32);
    if (!nickname) {
      return;
    }

    this.nickname = nickname;
    this.context.globalState.update('nickname', nickname);
    this.status = 'Connecting to DevTalk...';
    this.connect();
    this.postState();
  }

  async sendChat(rawText) {
    const text = rawText.trim();
    if (!text) {
      return;
    }
    if (!this.canSend()) {
      this.status = this.config.ready
        ? 'DevTalk is still connecting.'
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

  async uploadFile(file) {
    if (!this.canSend()) {
      this.status = this.config.ready
        ? 'DevTalk is still connecting.'
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
      this.config.roomId,
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
    this.status = 'Connected to DevTalk room ' + this.config.roomId;
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
    return Boolean(this.nickname && this.channel && this.config.ready);
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
      canSend: this.canSend(),
      maxFileSize: MAX_FILE_SIZE,
      theme: getTheme(),
      unreadCount: this.unreadCount,
      readMarkerMessageId: this.readMarkerMessageId,
      messages: this.messages
    });
  }
}

function getNickname(context) {
  const configured = vscode.workspace
    .getConfiguration('devtalk')
    .get('nickname', '');
  const configuredName = typeof configured === 'string' ? configured.trim() : '';
  const saved = context.globalState.get('nickname', '');
  const savedName = typeof saved === 'string' ? saved.trim() : '';

  return configuredName || savedName;
}

function getTheme() {
  const theme = vscode.workspace
    .getConfiguration('devtalk')
    .get('theme', 'default');

  return theme === 'work' ? 'work' : 'default';
}

function getSupabaseConfig() {
  const config = vscode.workspace.getConfiguration('devtalk');
  const url = String(config.get('supabaseUrl', '') || '').trim();
  const anonKey = String(config.get('supabaseAnonKey', '') || '').trim();
  const roomId = String(config.get('roomId', DEFAULT_ROOM_ID) || DEFAULT_ROOM_ID).trim();
  const bucket = String(config.get('storageBucket', DEFAULT_BUCKET) || DEFAULT_BUCKET).trim();

  if (!url || !anonKey) {
    return {
      ready: false,
      message: 'Set devtalk.supabaseUrl and devtalk.supabaseAnonKey to start.',
      url,
      anonKey,
      roomId,
      bucket
    };
  }

  return {
    ready: true,
    message: '',
    url,
    anonKey,
    roomId: roomId || DEFAULT_ROOM_ID,
    bucket: bucket || DEFAULT_BUCKET
  };
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
    .title { font-size: 12px; font-weight: 600; line-height: 1.3; }
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
      max-width: 86%;
      padding: 7px 9px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      line-height: 1.4;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .mine .bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
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
    .file-input { display: none; }

    body.theme-work {
      font-size: calc(var(--vscode-font-size) - 1px);
    }
    .theme-work .header { padding: 7px 9px 6px; }
    .theme-work .title { font-size: 11px; font-weight: 500; }
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
    }
    .theme-work .mine .bubble {
      background: transparent;
      color: var(--vscode-foreground);
      border-color: transparent;
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
  <main id="chat" class="chat" hidden>
    <header class="header">
      <div class="title">DevTalk</div>
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
    const form = document.getElementById('composer');
    const input = document.getElementById('input');
    const sendButton = document.getElementById('sendButton');
    const attachButton = document.getElementById('attachButton');
    const fileInput = document.getElementById('fileInput');
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

      if (state.needsNickname) {
        setupEl.hidden = false;
        chatEl.hidden = true;
        nicknameInput.focus();
        return;
      }

      setupEl.hidden = true;
      chatEl.hidden = false;
      statusEl.textContent = state.status || '';
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
