// ---- tiny DOM helpers ----
const $ = (q) => document.querySelector(q);

// UI elements
const messagesEl = $('#messages');
const inputEl = $('#input');
const sendBtn = $('#btn-send');
const clearBtn = $('#btn-clear');
const exportBtn = $('#btn-export');
const settingsBtn = $('#btn-settings');
const openSettingsBtn = $('#btn-open-settings'); // ok if missing
const settingsDlg = $('#settings');
const inpBase = $('#inp-base');
const inpToken = $('#inp-token');

// localStorage keys
const LS = { base: 'sm_base', token: 'sm_token', conv: 'sm_conv' };

// config helpers
function getCfg() {
  return {
    base: localStorage.getItem(LS.base) || 'http://localhost/php-chat-ui/api',
    token: localStorage.getItem(LS.token) || '',
    conv: localStorage.getItem(LS.conv) || ''
  };
}
function setCfg({ base, token, conv }) {
  if (base !== undefined) localStorage.setItem(LS.base, base);
  if (token !== undefined) localStorage.setItem(LS.token, token);
  if (conv !== undefined) localStorage.setItem(LS.conv, conv);
}

// chat UI helpers
function addMessage(role, content, { status } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble ' + (role === 'user' ? 'user' : 'assistant');

  const tag = document.createElement('div');
  tag.className = 'role ' + role;
  tag.textContent = role === 'user' ? 'You' : role === 'auditor' ? 'Auditor' : 'Assistant';

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = content || '';

  wrap.appendChild(tag);
  wrap.appendChild(body);

  if (status) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = status;
    wrap.appendChild(meta);
  }

  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { wrap, body };
}

function updateLastAssistant(delta) {
  const bodies = [...messagesEl.querySelectorAll('.bubble.assistant .body')];
  const last = bodies[bodies.length - 1];
  if (last) last.textContent += delta;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateLastAssistantStatus(text) {
  const bubbles = [...messagesEl.querySelectorAll('.bubble.assistant')];
  const last = bubbles[bubbles.length - 1];
  if (!last) return;
  let meta = last.querySelector('.meta');
  if (!meta) {
    meta = document.createElement('div');
    meta.className = 'meta';
    last.appendChild(meta);
  }
  meta.textContent = text;
}

function clearChat() {
  messagesEl.innerHTML = '';
  addMessage('assistant', window.__APP__?.initialMessage || 'Welcome!');
}

function exportChat() {
  const txt = [...messagesEl.querySelectorAll('.bubble')]
    .map((b) => {
      const who = b.querySelector('.role').textContent.toUpperCase();
      const body = b.querySelector('.body').textContent;
      return `${who}\n${body}\n`;
    })
    .join('\n');
  const blob = new Blob([txt], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `signalminedialog-${new Date().toISOString().slice(0, 19)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- network call via PHP proxy ----
async function callBackend(prompt) {
  const cfg = getCfg();

  // show user + assistant placeholder
  addMessage('user', prompt);
  addMessage('assistant', '', { status: 'Thinking…' });

  const resp = await fetch('../api/chat.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      conversation_id: cfg.conv,
      base: cfg.base,
      token: cfg.token,
      // intake: '/invoke/chat' // uncomment if you added intake support to chat.php
    })
  });

  const contentType = resp.headers.get('content-type') || ''; // <— define ctype **here**
  if (contentType.includes('text/event-stream')) {
    // streaming mode
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const j = line.slice(5).trim();
        if (j === '[DONE]') continue;
        try {
          const evt = JSON.parse(j);
          if (evt.delta) updateLastAssistant(evt.delta);
          if (evt.status) updateLastAssistantStatus(evt.status);
          if (evt.role === 'auditor' && evt.message) addMessage('auditor', evt.message);
          if (evt.conversation_id) setCfg({ conv: evt.conversation_id });
        } catch {
          // ignore malformed chunk
        }
      }
    }
  } else if (contentType.includes('application/json')) {
    const data = await resp.json();
    const msg = data.message || data.output || JSON.stringify(data, null, 2);
    updateLastAssistant(msg);
    if (data.conversation_id) setCfg({ conv: data.conversation_id });
  } else {
    const text = await resp.text();
    updateLastAssistant(text || '(no content)');
  }
}

// ---- init ----
(function init() {
  // initial assistant message
  addMessage('assistant', window.__APP__?.initialMessage || 'Welcome!');

  // hydrate settings UI if present
  const cfg = getCfg();
  if (inpBase) inpBase.value = cfg.base;
  if (inpToken) inpToken.value = cfg.token;

  // settings open/close
  settingsBtn?.addEventListener('click', () => settingsDlg?.showModal?.());
  openSettingsBtn?.addEventListener('click', () => settingsDlg?.showModal?.());
  settingsDlg?.addEventListener('close', () => {
    if (settingsDlg.returnValue !== 'cancel') {
      setCfg({
        base: inpBase?.value.trim(),
        token: inpToken?.value.trim()
      });
    }
  });

  // samples
  document.querySelectorAll('.sample').forEach((btn) =>
    btn.addEventListener('click', () => {
      inputEl.value = btn.textContent.trim();
      inputEl.focus();
    })
  );

  // send
  sendBtn?.addEventListener('click', async () => {
    const t = inputEl.value.trim();
    if (!t) return;
    inputEl.value = '';
    try {
      await callBackend(t);
    } catch (e) {
      updateLastAssistantStatus('Error – check PHP proxy/back-end URL');
    }
  });
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn?.click();
    }
  });

  // other buttons
  clearBtn?.addEventListener('click', clearChat);
  exportBtn?.addEventListener('click', exportChat);
})();
