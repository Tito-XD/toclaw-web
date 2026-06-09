// Config - connect to same origin (Caddy proxies WebSocket to gateway)
const GATEWAY_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;
const GATEWAY_TOKEN = 'e682960566d9436ba84bc65cb158708c561b66f6d52a4c6d9f542ae116ecfc5c'; // Token stays server-side in Caddy config

let ws = null;
let requestId = 0;
let pendingRequests = {};
let currentSessionKey = null;
let userId = null;
let connected = false;
let messageHistory = [];

// --- Login ---
function doLogin() {
  const input = document.getElementById('user-id').value.trim();
  if (!input) { alert('请输入 ID'); return; }
  userId = input;
  localStorage.setItem('toclaw_user_id', userId);
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('chat-screen').classList.add('active');
  connectGateway();
}

function doLogout() {
  localStorage.removeItem('toclaw_user_id');
  if (ws) ws.close();
  document.getElementById('chat-screen').classList.remove('active');
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('messages').innerHTML = '';
  connected = false;
}

// Auto-login
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('toclaw_user_id');
  if (saved) {
    document.getElementById('user-id').value = saved;
    doLogin();
  }
});

// --- WebSocket ---
function connectGateway() {
  setStatus('连接中...', '');
  ws = new WebSocket(GATEWAY_URL);

  ws.onopen = () => {
    console.log('WebSocket connected');
  };

  ws.onmessage = (event) => {
    try {
      const frame = JSON.parse(event.data);
      handleFrame(frame);
    } catch (e) {
      console.error('Parse error:', e);
    }
  };

  ws.onclose = () => {
    connected = false;
    setStatus('连接断开', 'error');
    // Auto-reconnect after 3s
    setTimeout(() => {
      if (document.getElementById('chat-screen').classList.contains('active')) {
        connectGateway();
      }
    }, 3000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    setStatus('连接错误', 'error');
  };
}

function handleFrame(frame) {
  // Server sends connect.challenge first
  if (frame.type === 'event' && frame.event === 'connect.challenge') {
    sendConnect(frame.payload);
    return;
  }

  // Response to our connect request
  if (frame.type === 'res' && frame.ok && frame.payload?.type === 'hello-ok') {
    connected = true;
    setStatus('已连接', 'connected');
    // Subscribe to session events
    subscribeSessions();
    // Send initial greeting
    setTimeout(() => {
      addMessage('system', `欢迎 ${userId}！你现在可以和小头虾聊天了 🐺`);
      // Try to find existing session or create new one
      findOrCreateSession();
    }, 500);
    return;
  }

  // Response to our requests
  if (frame.type === 'res' && frame.id && pendingRequests[frame.id]) {
    pendingRequests[frame.id](frame);
    delete pendingRequests[frame.id];
    return;
  }

  // Chat/agent events (streamed responses)
  if (frame.type === 'event') {
    handleChatEvent(frame);
  }
}

function sendConnect(challenge) {
  const connectFrame = {
    type: 'req',
    id: genId(),
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 4,
      client: {
        id: 'webchat',
        version: '1.0.0',
        platform: 'web',
        mode: 'operator'
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: GATEWAY_TOKEN },
      locale: 'zh-CN',
      userAgent: 'toclaw-webchat/1.0.0'
    }
  };
  wsSend(connectFrame);
}

function subscribeSessions() {
  wsSend({
    type: 'req',
    id: genId(),
    method: 'sessions.subscribe',
    params: {}
  });
}

function findOrCreateSession() {
  // List sessions to find one for this user
  wsSend({
    type: 'req',
    id: genId(),
    method: 'sessions.list',
    params: {}
  }, (res) => {
    if (res.ok && res.payload) {
      const sessions = res.payload;
      // Find the main session or any session linked to this user
      const mainSession = Object.keys(sessions).find(k => k.includes('main'));
      if (mainSession) {
        currentSessionKey = mainSession;
        // Load recent messages
        loadRecentMessages();
      }
    }
  });
}

function loadRecentMessages() {
  if (!currentSessionKey) return;
  wsSend({
    type: 'req',
    id: genId(),
    method: 'sessions.preview',
    params: { sessionKey: currentSessionKey }
  }, (res) => {
    if (res.ok && res.payload?.messages) {
      const msgs = res.payload.messages.slice(-20);
      msgs.forEach(m => {
        if (m.role === 'user') {
          addMessage('user', m.content, m.timestamp);
        } else if (m.role === 'assistant') {
          addMessage('bot', m.content, m.timestamp);
        }
      });
    }
  });
}

// --- Chat ---
function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !connected) return;

  input.value = '';
  input.style.height = 'auto';
  addMessage('user', text);

  // Show typing indicator
  const typingEl = addTyping();

  // Send via chat.send
  wsSend({
    type: 'req',
    id: genId(),
    method: 'chat.send',
    params: {
      text: text,
      sessionKey: currentSessionKey || undefined
    }
  }, (res) => {
    // Remove typing indicator
    if (typingEl) typingEl.remove();
    
    if (res.ok) {
      if (res.payload?.sessionKey) {
        currentSessionKey = res.payload.sessionKey;
      }
    } else {
      addMessage('system', '发送失败: ' + (res.error?.message || '未知错误'));
    }
  });
}

function handleChatEvent(frame) {
  const event = frame.event;
  const payload = frame.payload;

  // Streamed agent response
  if (event === 'agent' && payload?.text) {
    updateBotMessage(payload.text);
  }

  // Chat message completed
  if (event === 'chat.message' && payload?.role === 'assistant') {
    finalizeBotMessage(payload.content || payload.text);
  }

  // Session events
  if (event === 'session.updated' && payload?.sessionKey) {
    currentSessionKey = payload.sessionKey;
  }
}

let currentBotMessage = null;
let botMessageText = '';

function updateBotMessage(text) {
  botMessageText += text;
  if (!currentBotMessage) {
    currentBotMessage = addMessage('bot', botMessageText);
  } else {
    currentBotMessage.querySelector('.content').textContent = botMessageText;
  }
  scrollToBottom();
}

function finalizeBotMessage(text) {
  if (text) {
    if (currentBotMessage) {
      currentBotMessage.querySelector('.content').textContent = text;
    } else {
      addMessage('bot', text);
    }
  }
  currentBotMessage = null;
  botMessageText = '';
  scrollToBottom();
}

// --- UI ---
function addMessage(type, content, timestamp) {
  const messages = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = `message ${type}`;
  
  const contentEl = document.createElement('div');
  contentEl.className = 'content';
  contentEl.textContent = content;
  el.appendChild(contentEl);

  if (timestamp && type !== 'system') {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = formatTime(timestamp);
    el.appendChild(meta);
  }

  messages.appendChild(el);
  scrollToBottom();
  messageHistory.push({ type, content, timestamp: timestamp || new Date().toISOString() });
  return el;
}

function addTyping() {
  const messages = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = 'typing';
  el.id = 'typing-indicator';
  el.textContent = '小头虾正在思考...';
  messages.appendChild(el);
  scrollToBottom();
  return el;
}

function setStatus(text, cls) {
  const el = document.getElementById('connection-status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

function scrollToBottom() {
  const messages = document.getElementById('messages');
  messages.scrollTop = messages.scrollHeight;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  // Auto-resize textarea
  const ta = e.target;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

// --- Export ---
function exportChat() {
  const exportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    userId: userId,
    sessionKey: currentSessionKey,
    platform: 'toclaw-webchat',
    messages: messageHistory.map(m => ({
      role: m.type === 'user' ? 'user' : m.type === 'bot' ? 'assistant' : 'system',
      content: m.content,
      timestamp: m.timestamp
    }))
  };

  // Markdown export
  let md = `# 小头虾对话记录\n\n`;
  md += `- 用户: ${userId}\n`;
  md += `- 导出时间: ${exportData.exportedAt}\n`;
  md += `- 平台: ToClaw WebChat\n\n---\n\n`;
  exportData.messages.forEach(m => {
    if (m.role === 'system') return;
    const role = m.role === 'user' ? '**你**' : '**小头虾**';
    const time = formatTime(m.timestamp);
    md += `${role} (${time}):\n${m.content}\n\n`;
  });

  md += `\n---\n\n`;
  md += `## 使用说明\n\n`;
  md += `此对话记录可以导入到其他 AI Agent 中继续使用。\n`;
  md += `JSON 格式包含完整的结构化数据，Markdown 格式方便阅读。\n`;

  // Download both files
  downloadFile(`toclaw-chat-${userId}-${Date.now()}.json`, JSON.stringify(exportData, null, 2), 'application/json');
  downloadFile(`toclaw-chat-${userId}-${Date.now()}.md`, md, 'text/markdown');

  addMessage('system', '📥 对话已导出（JSON + Markdown）');
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Helpers ---
function genId() {
  return 'req_' + (++requestId) + '_' + Math.random().toString(36).substr(2, 6);
}

function wsSend(frame, callback) {
  if (callback && frame.id) {
    pendingRequests[frame.id] = callback;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}
