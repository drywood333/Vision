const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('chat-input');
const sendBtnEl = document.getElementById('send-btn');
const voiceEnabledEl = document.getElementById('voice-enabled');
const speakerBtnEl = document.getElementById('speaker-btn');
const voiceInputBtnEl = document.getElementById('voice-input-btn');
const chatStatusEl = document.getElementById('chat-status');
const STORAGE_KEY_TTS_ENABLED = 'vision-app-tts-enabled';
// const ONLINE_DEFAULT_API_BASE_URL = 'https://api.progredire.net';

let history = [];
let selectedMsgEls = [];
let bulkSendBtnEl = null;
let selectionSnapshotRootEl = null;
let ttsEnabled = false;
let preferredTtsVoice = null;

function getPreferredTtsVoice() {
  if (preferredTtsVoice) return preferredTtsVoice;
  const voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
  const itVoices = voices.filter(function (v) { return (v.lang || '').toLowerCase().startsWith('it'); });
  if (itVoices.length === 0) return null;
  var premium = ['google', 'premium', 'enhanced', 'natural', 'eloquence', 'quality'];
  var names = ['samantha', 'luca', 'silvia', 'federica', 'paola', 'giovanni', 'alice', 'daniel', 'microsoft', 'karen', 'moira'];
  function score(v) {
    var n = (v.name || '').toLowerCase();
    if (v.localService) return 2;
    for (var i = 0; i < premium.length; i++) if (n.indexOf(premium[i]) !== -1) return 2;
    for (var j = 0; j < names.length; j++) if (n.indexOf(names[j]) !== -1) return 1;
    return 0;
  }
  itVoices.sort(function (a, b) { return score(b) - score(a); });
  preferredTtsVoice = itVoices[0];
  return preferredTtsVoice;
}

function initTtsVoice() {
  function pick() {
    preferredTtsVoice = getPreferredTtsVoice();
  }
  if (typeof speechSynthesis === 'undefined') return;
  var voices = speechSynthesis.getVoices();
  if (voices.length > 0) pick();
  speechSynthesis.onvoiceschanged = function () {
    preferredTtsVoice = null;
    pick();
  };
}

function stripFormatting(text) {
  if (typeof text !== 'string') return '';
  let s = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '');
  s = s.replace(/\*\*/g, '').replace(/\*/g, '').replace(/__/g, '').replace(/~~/g, '').replace(/`/g, '');
  return s.trim();
}

function formatDateLabelForChat(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return day + '/' + month + '/' + year;
  } catch (_) {
    return '';
  }
}

async function refreshChatStatus() {
  if (!chatStatusEl) return;
  const base = getApiBaseUrl();
  const url = (base ? (base + '/api/status-ai') : '/api/status-ai');
  try {
    const res = await fetch(url);
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.error) {
      throw new Error((data && data.error) || ('HTTP ' + res.status));
    }
    const count = (typeof data.riassuntoCount === 'number') ? data.riassuntoCount : 0;
    const min = data.riassuntoMinDate || '';
    const max = data.riassuntoMaxDate || '';
    const minLbl = formatDateLabelForChat(min);
    const maxLbl = formatDateLabelForChat(max);
    let rangePart = '';
    if (minLbl && maxLbl) {
      rangePart = ' — ' + minLbl + ' \u2022 ' + maxLbl;
    } else if (minLbl || maxLbl) {
      rangePart = ' — ' + (minLbl || maxLbl);
    }
    chatStatusEl.textContent = 'articoli: ' + count + rangePart;
  } catch (_) {
    chatStatusEl.textContent = 'articoli: ?';
  }
}

async function sendSnippetToTelegramFromApp(role, text) {
  const base = getApiBaseUrl();
  const url = (base ? (base + '/api/send-telegram-snippet') : '/api/send-telegram-snippet');
  const payload = {
    role: role === 'assistant' ? 'assistant' : 'user',
    text: String(text || '')
  };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    throw new Error('Errore connessione per invio a Telegram: ' + (err && err.message ? err.message : String(err)));
  }
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok || !data.ok) {
    const msg = (data && data.error) ? data.error : (res.statusText || ('HTTP ' + res.status));
    throw new Error(msg);
  }
}

function ensureSelectionSnapshotRoot() {
  if (selectionSnapshotRootEl) return selectionSnapshotRootEl;
  const root = document.createElement('div');
  root.id = 'selection-snapshot-root';
  root.style.position = 'fixed';
  root.style.left = '-9999px';
  root.style.top = '-9999px';
  // Larghezza fissa pensata per Telegram (max ~360px)
  root.style.width = '360px';
  root.style.padding = '16px';
  root.style.background = '#111111';
  root.style.borderRadius = '12px';
  root.style.display = 'block';
  document.body.appendChild(root);
  selectionSnapshotRootEl = root;
  return root;
}

async function renderSelectionToPngBase64() {
  const valid = selectedMsgEls.filter(function (el) {
    return el && el.isConnected && el.classList.contains('msg-selected');
  });
  if (!valid.length) return null;
  if (typeof window.html2canvas !== 'function') return null;

  const root = ensureSelectionSnapshotRoot();
  root.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'messages snapshot-messages';
  valid.forEach(function (el) {
    const clone = el.cloneNode(true);
    clone.classList.remove('msg-selected');
    wrapper.appendChild(clone);
  });
  root.appendChild(wrapper);

  try {
    const canvas = await window.html2canvas(wrapper, {
      backgroundColor: '#111111',
      scale: window.devicePixelRatio || 1
    });
    const dataUrl = canvas.toDataURL('image/png');
    const commaIdx = dataUrl.indexOf(',');
    return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : null;
  } catch (err) {
    console.warn('renderSelectionToPngBase64 failed:', err);
    return null;
  }
}

async function sendSelectionImageToTelegramFromApp(base64Png, fallbackText) {
  const base = getApiBaseUrl();
  const url = (base ? (base + '/api/send-telegram-image-snippet') : '/api/send-telegram-image-snippet');
  const payload = {
    image_base64: String(base64Png || ''),
    text: String(fallbackText || '')
  };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    throw new Error('Errore connessione per invio immagine a Telegram: ' + (err && err.message ? err.message : String(err)));
  }
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok || !data.ok) {
    const msg = (data && data.error) ? data.error : (res.statusText || ('HTTP ' + res.status));
    throw new Error(msg);
  }
}

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
  const displayText = role === 'assistant' ? stripFormatting(text) : String(text || '');

  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.textContent = displayText;
  div.appendChild(textEl);

  div.addEventListener('click', function (e) {
    toggleMessageSelection(div, role, displayText);
  });

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function toggleMessageSelection(msgEl, role, text) {
  const isSelected = msgEl.classList.toggle('msg-selected');
  selectedMsgEls = selectedMsgEls.filter(function (el) { return el && el.isConnected; });
  if (isSelected) {
    if (selectedMsgEls.indexOf(msgEl) === -1) selectedMsgEls.push(msgEl);
  } else {
    selectedMsgEls = selectedMsgEls.filter(function (el) { return el !== msgEl; });
  }
  updateBulkSendButtonVisibility();
}

function ensureBulkSendButton() {
  if (bulkSendBtnEl) return bulkSendBtnEl;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bulk-send-tg-btn';
  btn.textContent = 'Invia selezionati su Telegram';
  btn.addEventListener('click', async function () {
    selectedMsgEls = selectedMsgEls.filter(function (el) { return el && el.isConnected && el.classList.contains('msg-selected'); });
    if (!selectedMsgEls.length) return;
    const parts = [];
    selectedMsgEls.forEach(function (el) {
      const isUser = el.classList.contains('user');
      const roleLabel = isUser ? 'Domanda' : 'Risposta';
      const txtNode = el.querySelector('.msg-text');
      const txt = txtNode ? txtNode.textContent : el.textContent || '';
      parts.push(roleLabel + ': ' + txt);
    });
    const combined = parts.join('\n\n');
    try {
      const imageBase64 = await renderSelectionToPngBase64();
      if (imageBase64) {
        // Invia solo l'immagine su Telegram (nessuna caption).
        await sendSelectionImageToTelegramFromApp(imageBase64, '');
      } else {
        // Fallback: se per qualche motivo non riusciamo a generare l'immagine,
        // invia il testo concatenato come prima.
        await sendSnippetToTelegramFromApp('assistant', combined);
      }
      selectedMsgEls.forEach(function (el) { el.classList.remove('msg-selected'); });
      selectedMsgEls = [];
      updateBulkSendButtonVisibility();
      appendMessage('assistant', 'Selezione inviata al Telegram del report.');
    } catch (err) {
      appendMessage('assistant', '[Errore invio Telegram selezione] ' + (err && err.message ? err.message : String(err)));
    }
  });
  const panel = document.querySelector('.chat-panel') || document.body;
  panel.appendChild(btn);
  bulkSendBtnEl = btn;
  return btn;
}

function updateBulkSendButtonVisibility() {
  const btn = ensureBulkSendButton();
  const hasSelection = selectedMsgEls.some(function (el) { return el && el.isConnected && el.classList.contains('msg-selected'); });
  btn.style.display = hasSelection ? 'inline-flex' : 'none';
}

function setSending(sending) {
  sendBtnEl.disabled = sending;
  inputEl.disabled = sending;
  sendBtnEl.textContent = sending ? '...' : 'Invia';
  if (voiceInputBtnEl) voiceInputBtnEl.disabled = sending;
}

function canSpeak() {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';
}

function canRecognizeSpeech() {
  if (typeof window === 'undefined') return false;
  const C = window.SpeechRecognition || window.webkitSpeechRecognition;
  return typeof C === 'function';
}

function initVoiceInput() {
  if (!voiceInputBtnEl || !inputEl) return;
  var isSecure = typeof location !== 'undefined' && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  if (!isSecure) {
    voiceInputBtnEl.disabled = true;
    voiceInputBtnEl.title = 'Il microfono funziona solo su HTTPS o localhost';
    return;
  }
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    voiceInputBtnEl.disabled = true;
    voiceInputBtnEl.title = 'Riconoscimento vocale non supportato da questo browser';
    return;
  }
  let isListening = false;
  let currentRecognition = null;

  function stopListening() {
    isListening = false;
    voiceInputBtnEl.classList.remove('is-listening');
    voiceInputBtnEl.title = 'Inserisci a voce';
    currentRecognition = null;
  }

  voiceInputBtnEl.addEventListener('click', function () {
    if (sendBtnEl.disabled) return;
    if (isListening) {
      if (currentRecognition) try { currentRecognition.stop(); } catch (_) {}
      return;
    }
    voiceInputBtnEl.classList.add('is-listening');
    voiceInputBtnEl.title = 'In ascolto... Clicca di nuovo per fermare';

    var recognition = new SpeechRecognitionCtor();
    recognition.lang = 'it-IT';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = function () {
      isListening = true;
      currentRecognition = recognition;
    };

    recognition.onresult = function (event) {
      var results = event.results;
      if (!results || !results.length) return;
      var text = '';
      for (var i = 0; i < results.length; i++) {
        if (results[i].isFinal) text += results[i][0].transcript;
      }
      text = text.trim();
      if (text) {
        var current = String(inputEl.value || '').trim();
        inputEl.value = current ? current + ' ' + text : text;
      }
    };

    recognition.onend = function () {
      if (currentRecognition === recognition) stopListening();
    };

    recognition.onerror = function (event) {
      if (currentRecognition === recognition) stopListening();
      if (event.error === 'not-allowed') {
        voiceInputBtnEl.title = 'Consenti l\'accesso al microfono e riprova';
        appendMessage('assistant', 'Microfono non consentito. Clicca sull\'icona del lucchetto o dell\'informazione nella barra degli indirizzi, consenti l\'accesso al microfono per questo sito e riprova.');
      } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
        console.warn('Voice recognition error:', event.error);
      }
    };

    try {
      recognition.start();
    } catch (err) {
      console.warn('Voice recognition start failed:', err);
      stopListening();
    }
  });
}

function speakText(text) {
  if (!ttsEnabled || !canSpeak()) return;
  const value = String(text || '').trim();
  if (!value) return;
  const utter = new SpeechSynthesisUtterance(value);
  utter.lang = 'it-IT';
  var voice = getPreferredTtsVoice();
  if (voice) utter.voice = voice;
  utter.rate = 0.92;
  utter.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

function initVoiceToggle() {
  function syncVoiceUiState() {
    if (!speakerBtnEl) return;
    speakerBtnEl.classList.toggle('is-enabled', ttsEnabled);
    speakerBtnEl.setAttribute('aria-pressed', ttsEnabled ? 'true' : 'false');
    speakerBtnEl.title = ttsEnabled ? 'Voce attiva' : 'Voce disattivata';
  }
  const supported = canSpeak();
  if (!supported) {
    voiceEnabledEl.checked = false;
    voiceEnabledEl.disabled = true;
    ttsEnabled = false;
    syncVoiceUiState();
    return;
  }
  // Rimuoviamo il caricamento dal localStorage per forzare default disattivato
  ttsEnabled = false;
  voiceEnabledEl.checked = ttsEnabled;
  syncVoiceUiState();
  
  // Opzionale: puliamo il localStorage all'avvio per evitare confusione
  try {
    localStorage.removeItem(STORAGE_KEY_TTS_ENABLED);
  } catch (_) {}

  voiceEnabledEl.addEventListener('change', function () {
    ttsEnabled = Boolean(voiceEnabledEl.checked);
    // Non salviamo più nel localStorage, così al reload torna false
    /* 
    try {
      if (ttsEnabled) localStorage.setItem(STORAGE_KEY_TTS_ENABLED, '1');
      else localStorage.removeItem(STORAGE_KEY_TTS_ENABLED);
    } catch (_) {} 
    */
    if (!ttsEnabled && canSpeak()) window.speechSynthesis.cancel();
    syncVoiceUiState();
  });
}

function getAutoDefaultApiBaseUrl() {
  const configured = typeof window.VISION_APP_DEFAULT_API_BASE_URL === 'string'
    ? normalizeApiBaseUrl(window.VISION_APP_DEFAULT_API_BASE_URL)
    : '';
  if (configured) return configured;
  const protocol = String(window.location.protocol || '').toLowerCase();
  const host = String(window.location.hostname || '').toLowerCase();
  if (protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return 'http://localhost:3002';
  }
  return 'https://api.progredire.net';
}

function normalizeApiBaseUrl(value) {
  let out = String(value || '').trim();
  out = out.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '').trim();
  return out.replace(/\/+$/, '');
}

function getApiBaseUrl() {
  return getAutoDefaultApiBaseUrl();
}

async function sendMessage(userText) {
  const base = getApiBaseUrl();
  const url = (base ? (base + '/api/ai-chat') : '/api/ai-chat');
  const payload = {
    user: userText,
    history: history.slice(-20)
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    const errorMsg = 'Impossibile raggiungere il server API.\n' +
      'URL provato: ' + url + '\n' +
      'Verifica la connessione internet o contatta l\'assistenza.';
    throw new Error(errorMsg);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    if (res.status === 404) {
      throw new Error('Endpoint non trovato (404). Verifica che il server esponga POST /api/ai-chat.');
    }
    throw new Error((data && data.error) || ('HTTP ' + res.status));
  }
  return String(data.reply || '').trim() || '(Nessuna risposta)';
}

// Gestione invio con tasto Enter (e a capo con Shift+Enter)
inputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    formEl.dispatchEvent(new Event('submit', { cancelable: true }));
  }
});

formEl.addEventListener('submit', async function (e) {
  e.preventDefault();
  const text = String(inputEl.value || '').trim();
  if (!text) return;
  appendMessage('user', text);
  inputEl.value = '';
  setSending(true);
  try {
    const reply = await sendMessage(text);
    const replyPlain = stripFormatting(reply);
    appendMessage('assistant', reply);
    speakText(replyPlain);
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    refreshChatStatus();
  } catch (err) {
    appendMessage('assistant', '[Errore] ' + (err && err.message ? err.message : String(err)));
  } finally {
    setSending(false);
  }
});

initTtsVoice();
initVoiceToggle();
initVoiceInput();
refreshChatStatus();
appendMessage('assistant', 'Vision App pronta. Fai una domanda.');
