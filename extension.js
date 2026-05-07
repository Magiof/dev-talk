const vscode = require('vscode');
const os = require('os');
const crypto = require('crypto');

const MULTICAST_ADDRESS = '239.255.42.99';
const GLOBAL_BROADCAST_ADDRESS = '255.255.255.255';
const PORT = 45454;

function activate(context) {
  const provider = new LanChatViewProvider(context);
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

class LanChatViewProvider {
  constructor(context) {
    this.context = context;
    this.peerId = createId();
    this.webviewView = undefined;
    this.socket = undefined;
    this.messages = [];
    this.seenMessageIds = new Set();
    this.unreadCount = 0;
    this.unreadStartMessageId = undefined;
    this.readMarkerMessageId = undefined;
    this.status = 'Connecting to DevTalk...';
    this.nickname = getNickname(context);
    if (!this.nickname) {
      this.status = 'Enter your name to start.';
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
      if (message.type === 'ready') {
        if (this.isViewVisible()) {
          this.markRead();
          return;
        }
        this.postState();
      }
    });

    if (this.nickname) {
      this.startSocket();
    }
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

  startSocket() {
    if (!this.nickname) {
      return;
    }
    if (this.socket) {
      return;
    }

    const dgram = require('dgram');
    this.socket = dgram.createSocket({
      type: 'udp4',
      reuseAddr: true
    });

    this.socket.on('error', (error) => {
      this.status = `DevTalk unavailable: ${error.message}`;
      this.postState();
    });

    this.socket.on('message', (buffer) => {
      let payload;
      try {
        payload = JSON.parse(buffer.toString('utf8'));
      } catch {
        return;
      }

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
        mine: false,
        sentAt: Number(payload.sentAt) || Date.now()
      });
    });

    this.socket.bind(PORT, () => {
      try {
        this.socket.setBroadcast(true);
        this.socket.addMembership(MULTICAST_ADDRESS);
        this.socket.setMulticastTTL(1);
        this.status = 'Same-Wi-Fi DevTalk on UDP port ' + PORT;
      } catch (error) {
        this.status = `DevTalk unavailable: ${error.message}`;
      }
      this.postState();
    });

    this.context.subscriptions.push({
      dispose: () => {
        if (this.socket) {
          this.socket.close();
        }
      }
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
    this.startSocket();
    this.postState();
  }

  sendChat(rawText) {
    const text = rawText.trim();
    if (!this.nickname || !text || !this.socket) {
      return;
    }

    const message = {
      id: createId(),
      kind: 'devtalk-message',
      peerId: this.peerId,
      nickname: this.nickname,
      text,
      sentAt: Date.now()
    };

    const buffer = Buffer.from(JSON.stringify(message), 'utf8');
    for (const address of getSendAddresses()) {
      this.socket.send(buffer, PORT, address);
    }
    this.addMessage({
      id: message.id,
      text,
      nickname: this.nickname,
      mine: true,
      sentAt: message.sentAt
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

  postState() {
    if (!this.webviewView) {
      return;
    }

    this.webviewView.webview.postMessage({
      type: 'state',
      nickname: this.nickname,
      status: this.status,
      needsNickname: !this.nickname,
      unreadCount: this.unreadCount,
      readMarkerMessageId: this.readMarkerMessageId,
      messages: this.messages
    });
  }
}

function getSendAddresses() {
  const addresses = new Set([MULTICAST_ADDRESS, GLOBAL_BROADCAST_ADDRESS]);

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.address || !entry.netmask) {
        continue;
      }

      const broadcast = getBroadcastAddress(entry.address, entry.netmask);
      if (broadcast) {
        addresses.add(broadcast);
      }
    }
  }

  return [...addresses];
}

function getBroadcastAddress(address, netmask) {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  if (ip === undefined || mask === undefined) {
    return undefined;
  }

  return intToIpv4((ip | (~mask >>> 0)) >>> 0);
}

function ipv4ToInt(value) {
  const parts = value.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }

  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function intToIpv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join('.');
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

function getWebviewHtml(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DevTalk</title>
  <style>
    :root {
      color-scheme: light dark;
    }

    * {
      box-sizing: border-box;
    }

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

    .setup[hidden],
    .chat[hidden] {
      display: none;
    }

    .setup-title {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.35;
    }

    .setup-help {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.45;
    }

    .setup-form {
      display: grid;
      gap: 8px;
    }

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

    .title {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.3;
    }

    .status {
      margin-top: 3px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .messages {
      min-height: 0;
      overflow-y: auto;
      padding: 10px;
    }

    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.45;
      padding-top: 4px;
    }

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

    .read-marker::before,
    .read-marker::after {
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

    .message.mine {
      align-items: flex-end;
    }

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

    .composer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
      padding: 8px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      background: var(--vscode-sideBar-background);
    }

    input,
    textarea {
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

    input:focus,
    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }

    button {
      min-width: 44px;
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

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <section id="setup" class="setup" hidden>
    <div class="setup-title">Choose your chat name</div>
    <div class="setup-help">This name is shown to people on the same Wi-Fi.</div>
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
      <textarea id="input" rows="1" placeholder="Message"></textarea>
      <button type="submit">Send</button>
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
    let isComposing = false;

    function formatTime(value) {
      return new Date(value).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    function render(state) {
      if (state.needsNickname) {
        setupEl.hidden = false;
        chatEl.hidden = true;
        nicknameInput.focus();
        return;
      }

      setupEl.hidden = true;
      chatEl.hidden = false;
      statusEl.textContent = state.status || '';
      messagesEl.textContent = '';

      if (!state.messages || state.messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Messages from the same Wi-Fi network will appear here.';
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
        bubble.textContent = message.text;

        item.append(meta, bubble);
        messagesEl.appendChild(item);
      }

      messagesEl.scrollTop = messagesEl.scrollHeight;
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
