let urlList = [];
let urlFilter = '';
let urlsLoaded = false; // Safety flag
let jsonFolderState = { folders: [], active: '' };
let secondaryLinksQueue = [];

const TEST_MAX_ARTICOLI = 0;
const RUN_FASE_2B_LINK_SECONDARI = false; // true = analizza link secondari (Fase 2B); false = sospesa (scrittura link in link_secondari.json resta attiva)
const ALLOWED_CONCURRENT = [1, 10, 50, 100, 150];
// Valori slider batch: OFF, 1min, 1h, 2h, ... 12h
const ALLOWED_BATCH_WAIT_MINUTES = [0, 1, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720];
let batchWaitMinutes = 0;
let batchAutoRestartTimer = null;
let batchCountdownInterval = null;

// Default sicuro: la forzatura sintesi per ogni articolo valido è disattivata
// (evita ReferenceError se il toggle non è presente nella UI).
let forceSintesiEachValid = false;
let forceReprocessExisting = false;
let emailProgressivo = 0;
let aiChatHistory = [];
let isApplyingFolderSettings = false;
let currentArticles = []; // Store found articles globalmente

function updateAppTitleFolderSuffix() {
    var titleEl = document.getElementById('app-title');
    if (!titleEl) return;
    var folder = jsonFolderState.active || '';
    var label = folder || 'Principale';
    // Se c'è un timer attivo, non sovrascrivere tutto ma preserva il suffisso
    // La logica del timer userà il testo base per appendere il countdown
    if (!batchCountdownInterval) {
        titleEl.textContent = 'Vision AI - ' + label;
    } else {
        // Se il timer è attivo, aggiorna solo la parte base se necessario (o lascialo gestire al timer)
        // Per semplicità, il timer ricostruisce l'intera stringa.
    }
}

function updateAppTitleBatchTimer(targetTime) {
    var titleEl = document.getElementById('app-title');
    if (!titleEl) return;
    
    if (batchCountdownInterval) {
        clearInterval(batchCountdownInterval);
        batchCountdownInterval = null;
    }

    if (!targetTime) {
        // Ripristina titolo standard
        updateAppTitleFolderSuffix();
        return;
    }

    function refresh() {
        var now = Date.now();
        var diff = targetTime - now;
        if (diff <= 0) {
            if (batchCountdownInterval) {
                clearInterval(batchCountdownInterval);
                batchCountdownInterval = null;
            }
            updateAppTitleFolderSuffix();
            return;
        }
        var totalSec = Math.ceil(diff / 1000);
        var h = Math.floor(totalSec / 3600);
        var m = Math.floor((totalSec % 3600) / 60);
        var s = totalSec % 60;
        
        var hStr = h < 10 ? '0' + h : h;
        var mStr = m < 10 ? '0' + m : m;
        var sStr = s < 10 ? '0' + s : s;
        var timeStr = hStr + ':' + mStr + ':' + sStr;
        
        var folder = jsonFolderState.active || '';
        var label = folder || 'Principale';
        titleEl.innerHTML = 'Vision AI - ' + label + ' <span style="color:#eab308; font-size:0.5em; margin-left:8px; font-family:\'Fira Code\', monospace; letter-spacing:-0.5px; opacity:0.8;">Riavvio ' + timeStr + '</span>';
    }

    refresh();
    batchCountdownInterval = setInterval(refresh, 1000);
}

function initDebugCheckbox() {
    function initOne(id) {
        var cb = document.getElementById(id);
        if (!cb) return;
        cb.checked = false;
        function save() {
            if (!isApplyingFolderSettings) saveFolderSettings().catch(function () {});
        }
        cb.addEventListener('change', save);
        cb.addEventListener('click', function () { setTimeout(save, 0); });
    }
    initOne('debug-one-article');
    initOne('only-search-phase');
    initOne('log-show-questions');
    initOne('log-show-responses');
    initOne('use-emwa-params');
    initOne('force-deepseek-chat');
    initOne('auto-send-email');
    initOne('telegram-elab-report');
    initOne('force-reprocess-existing');
}

function addSecondaryLink(url, date) {
    try {
        var u = String(url || '').trim();
        if (!u) return;
        secondaryLinksQueue.push({ url: u, date: date || null });
        logToConsole('Link secondario aggiunto: ' + u, 'info');
    } catch (_) {}
}

function initAnalyzeConcurrentSelector() {
    var opts = document.getElementById('analyze-concurrent-options');
    if (!opts) return;
    var btns = opts.querySelectorAll('.validity-btn');
    // Non forzare un valore di default qui: lo stato "active" iniziale
    // viene impostato dall'HTML oppure da loadFolderSettings() tramite setAnalyzeConcurrent.
    btns.forEach(function (btn) {
        btn.onclick = function () {
            var v = parseInt(btn.dataset.value, 10);
            if (ALLOWED_CONCURRENT.indexOf(v) === -1) return;
            btns.forEach(function (b) { b.classList.remove('active'); });
            btn.classList.add('active');
            updateActiveAgentsUI();
            if (!isApplyingFolderSettings) saveFolderSettings().catch(function () {});
        };
    });
}

function getParallelAnalyzeLimit() {
    var opts = document.getElementById('analyze-concurrent-options');
    if (!opts) return 1;
    var active = opts.querySelector('.validity-btn.active');
    if (!active) return 1;
    var v = parseInt(active.dataset.value, 10);
    return ALLOWED_CONCURRENT.indexOf(v) !== -1 ? v : 1;
}

function formatBatchWaitLabel(minutes) {
    var m = parseInt(minutes, 10);
    if (!m || m <= 0) return 'OFF';
    if (m < 60) return m + 'min';
    return Math.floor(m / 60) + 'h';
}

function setBatchWaitMinutes(minutes) {
    var m = parseInt(minutes, 10);
    if (m === 10) m = 3;
    if (ALLOWED_BATCH_WAIT_MINUTES.indexOf(m) === -1) m = 0;
    batchWaitMinutes = m;
    var idx = ALLOWED_BATCH_WAIT_MINUTES.indexOf(m);
    if (idx < 0) idx = 0;
    var range = document.getElementById('batch-wait-range');
    var valueEl = document.getElementById('batch-wait-value');
    if (range) range.value = String(idx);
    if (valueEl) valueEl.textContent = formatBatchWaitLabel(m);
    if (m === 0 && batchAutoRestartTimer) {
        clearTimeout(batchAutoRestartTimer);
        batchAutoRestartTimer = null;
    }
}

function getBatchWaitMinutes() {
    return ALLOWED_BATCH_WAIT_MINUTES.indexOf(batchWaitMinutes) !== -1 ? batchWaitMinutes : 0;
}

function initBatchWaitSelector() {
    var range = document.getElementById('batch-wait-range');
    if (!range) return;
    range.min = '0';
    range.max = String(ALLOWED_BATCH_WAIT_MINUTES.length - 1);
    range.step = '1';
    setBatchWaitMinutes(batchWaitMinutes);
    range.addEventListener('input', function () {
        var idx = parseInt(range.value, 10);
        if (isNaN(idx) || idx < 0) idx = 0;
        if (idx >= ALLOWED_BATCH_WAIT_MINUTES.length) idx = ALLOWED_BATCH_WAIT_MINUTES.length - 1;
        var valueEl = document.getElementById('batch-wait-value');
        if (valueEl) valueEl.textContent = formatBatchWaitLabel(ALLOWED_BATCH_WAIT_MINUTES[idx]);
    });
    range.addEventListener('change', function () {
        var idx = parseInt(range.value, 10);
        if (isNaN(idx) || idx < 0) idx = 0;
        if (idx >= ALLOWED_BATCH_WAIT_MINUTES.length) idx = ALLOWED_BATCH_WAIT_MINUTES.length - 1;
        setBatchWaitMinutes(ALLOWED_BATCH_WAIT_MINUTES[idx]);
        if (!isApplyingFolderSettings) saveFolderSettings().catch(function () {});
    });
}

var aiChatContextMenuEl = null;
var aiChatContextTargetEl = null;
var aiChatLongPressTimer = null;
var aiChatSelectedMsgEls = [];
var aiChatBulkSendBtnEl = null;

function appendAiChatMessage(role, text) {
    var box = document.getElementById('ai-chat-messages');
    if (!box) return;
    var msg = document.createElement('div');
    msg.className = 'ai-chat-msg ' + (role === 'user' ? 'user' : 'assistant');
    var safeText = String(text || '');
    msg.textContent = safeText;
    msg.dataset.role = (role === 'assistant') ? 'assistant' : 'user';
    msg.dataset.text = safeText;
    // Pulsante esplicito per aprire il menu Telegram
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-chat-msg-send-tg';
    btn.title = 'Invia questo messaggio al Telegram del report';
    btn.textContent = '↗';
    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openAiChatContextMenu(msg, e.clientX, e.clientY);
    });
    msg.appendChild(btn);
    msg.addEventListener('click', function (e) {
        if (e.target === btn) return;
        toggleAiChatMessageSelection(msg);
    });
    attachAiChatContextHandlers(msg, msg.dataset.role, safeText);
    box.appendChild(msg);
    box.scrollTop = box.scrollHeight;
    updateAiChatBulkSendButtonVisibility();
}

function getOrCreateAiChatContextMenu() {
    if (aiChatContextMenuEl) return aiChatContextMenuEl;
    var menu = document.createElement('div');
    menu.id = 'ai-chat-context-menu';
    menu.className = 'ai-chat-context-menu';
    var btnSendOne = document.createElement('button');
    btnSendOne.type = 'button';
    btnSendOne.textContent = 'Invia questo messaggio al Telegram del report';
    btnSendOne.addEventListener('click', function () {
        if (!aiChatContextTargetEl) {
            closeAiChatContextMenu();
            return;
        }
        var role = aiChatContextTargetEl.dataset.role || 'user';
        var text = aiChatContextTargetEl.dataset.text || aiChatContextTargetEl.textContent || '';
        sendChatSnippetToTelegram(role, text).catch(function () {});
        closeAiChatContextMenu();
    });
    menu.appendChild(btnSendOne);

    var btnToggleSel = document.createElement('button');
    btnToggleSel.type = 'button';
    btnToggleSel.textContent = 'Seleziona messaggio';
    btnToggleSel.addEventListener('click', function () {
        if (!aiChatContextTargetEl) {
            closeAiChatContextMenu();
            return;
        }
        toggleAiChatMessageSelection(aiChatContextTargetEl);
        closeAiChatContextMenu();
    });
    menu.appendChild(btnToggleSel);
    menu._btnToggleSel = btnToggleSel;
    document.body.appendChild(menu);
    aiChatContextMenuEl = menu;
    document.addEventListener('click', function (e) {
        if (!aiChatContextMenuEl) return;
        if (e.target === aiChatContextMenuEl || aiChatContextMenuEl.contains(e.target)) return;
        closeAiChatContextMenu();
    });
    return menu;
}

function openAiChatContextMenu(targetEl, clientX, clientY) {
    aiChatContextTargetEl = targetEl;
    var menu = getOrCreateAiChatContextMenu();
    if (menu && menu._btnToggleSel) {
        menu._btnToggleSel.textContent = targetEl.classList.contains('msg-selected')
            ? 'Deseleziona messaggio'
            : 'Seleziona messaggio';
    }
    menu.style.display = 'block';
    var padding = 8;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var x = clientX + padding;
    var y = clientY + padding;
    menu.style.left = '0px';
    menu.style.top = '0px';
    var rect = menu.getBoundingClientRect();
    if (x + rect.width > vw) x = Math.max(padding, vw - rect.width - padding);
    if (y + rect.height > vh) y = Math.max(padding, vh - rect.height - padding);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
}

function closeAiChatContextMenu() {
    if (aiChatContextMenuEl) {
        aiChatContextMenuEl.style.display = 'none';
    }
    aiChatContextTargetEl = null;
}

function getAiChatSelectedMessagesInDomOrder() {
    var box = document.getElementById('ai-chat-messages');
    if (!box) return [];
    var ordered = Array.prototype.slice.call(box.querySelectorAll('.ai-chat-msg.msg-selected'))
        .filter(function (el) { return el && el.isConnected; });
    aiChatSelectedMsgEls = ordered.slice();
    return ordered;
}

function toggleAiChatMessageSelection(msgEl) {
    if (!msgEl) return;
    msgEl.classList.toggle('msg-selected');
    aiChatSelectedMsgEls = aiChatSelectedMsgEls.filter(function (el) { return el && el.isConnected; });
    if (msgEl.classList.contains('msg-selected')) {
        if (aiChatSelectedMsgEls.indexOf(msgEl) === -1) aiChatSelectedMsgEls.push(msgEl);
    } else {
        aiChatSelectedMsgEls = aiChatSelectedMsgEls.filter(function (el) { return el !== msgEl; });
    }
    updateAiChatBulkSendButtonVisibility();
}

function ensureAiChatBulkSendButton() {
    if (aiChatBulkSendBtnEl) return aiChatBulkSendBtnEl;
    var panel = document.getElementById('panel-chat-container') || document.querySelector('.ai-chat-panel') || document.body;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-chat-bulk-send-btn';
    btn.textContent = 'Invia selezionati al Telegram del report';
    btn.addEventListener('click', function () {
        sendAiChatSelectionToTelegram().catch(function () {});
    });
    panel.appendChild(btn);
    aiChatBulkSendBtnEl = btn;
    return btn;
}

async function sendAiChatSelectionToTelegram() {
    var selectedInOrder = getAiChatSelectedMessagesInDomOrder();
    if (!selectedInOrder.length) return;
    var parts = [];
    selectedInOrder.forEach(function (el) {
        var isUser = el.classList.contains('user');
        var roleLabel = isUser ? 'Domanda' : 'Risposta';
        var txt = (el.dataset && typeof el.dataset.text === 'string') ? el.dataset.text : (el.textContent || '');
        parts.push(roleLabel + ': ' + String(txt || '').trim());
    });
    var combined = parts.join('\n\n');
    await sendChatSnippetToTelegram('assistant', combined);
    selectedInOrder.forEach(function (el) { el.classList.remove('msg-selected'); });
    aiChatSelectedMsgEls = [];
    updateAiChatBulkSendButtonVisibility();
}

function updateAiChatBulkSendButtonVisibility() {
    var btn = ensureAiChatBulkSendButton();
    var hasSelection = getAiChatSelectedMessagesInDomOrder().length > 0;
    btn.style.display = hasSelection ? 'inline-flex' : 'none';
}

function attachAiChatContextHandlers(msgEl, role, text) {
    function startPress(clientX, clientY) {
        clearTimeout(aiChatLongPressTimer);
        aiChatLongPressTimer = setTimeout(function () {
            openAiChatContextMenu(msgEl, clientX, clientY);
        }, 700);
    }
    function cancelPress() {
        clearTimeout(aiChatLongPressTimer);
    }
    msgEl.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        startPress(e.clientX, e.clientY);
    });
    msgEl.addEventListener('mouseup', cancelPress);
    msgEl.addEventListener('mouseleave', cancelPress);
    msgEl.addEventListener('touchstart', function (e) {
        if (!e.touches || !e.touches.length) return;
        var t = e.touches[0];
        startPress(t.clientX, t.clientY);
    }, { passive: true });
    msgEl.addEventListener('touchend', cancelPress);
    msgEl.addEventListener('touchcancel', cancelPress);
    msgEl.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openAiChatContextMenu(msgEl, e.clientX, e.clientY);
    });
}

async function sendChatSnippetToTelegram(role, text) {
    var payload = {
        role: role || 'user',
        text: String(text || '')
    };
    try {
        var res = await fetch('/api/send-telegram-snippet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        var data = {};
        try {
            data = await res.json();
        } catch (_) {}
        if (!res.ok || !data.ok) {
            var errMsg = (data && data.error) ? data.error : (res.statusText || 'Errore invio Telegram');
            logToConsole('Errore invio snippet Telegram: ' + errMsg, 'error');
        } else {
            logToConsole('Snippet chat inviato al bot Telegram del report.', 'success');
        }
    } catch (e) {
        logToConsole('Errore invio snippet Telegram: ' + e.message, 'error');
    }
}

function setAiChatSendEnabled(enabled) {
    var btn = document.getElementById('ai-chat-send');
    var input = document.getElementById('ai-chat-input');
    if (btn) {
        btn.disabled = !enabled;
        btn.textContent = enabled ? 'Invia' : '...';
    }
    if (input) input.disabled = !enabled;
}

async function sendAiChatMessage() {
    var input = document.getElementById('ai-chat-input');
    if (!input) return;
    var text = String(input.value || '').trim();
    if (!text) return;
    appendAiChatMessage('user', text);
    input.value = '';
    setAiChatSendEnabled(false);
    try {
        var useEmwaParams = !!(document.getElementById('use-emwa-params') && document.getElementById('use-emwa-params').checked);
        var res = await fetch('/api/ai-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user: text,
                // Allineiamo al comportamento della Vision App: ultimi 20 messaggi di storico
                history: aiChatHistory.slice(-20),
                use_emwa_params: useEmwaParams
            })
        });
        var data = await res.json();
        if (!res.ok || data.error) {
            appendAiChatMessage('assistant', '[Errore] ' + (data && data.error ? data.error : 'Risposta non valida'));
            return;
        }
        var reply = String((data && data.reply) || '').trim();
        if (!reply) reply = '(Nessuna risposta)';
        appendAiChatMessage('assistant', reply);
        aiChatHistory.push({ role: 'user', content: text });
        aiChatHistory.push({ role: 'assistant', content: reply });
    } catch (e) {
        appendAiChatMessage('assistant', '[Errore] ' + e.message);
    } finally {
        setAiChatSendEnabled(true);
    }
}

function initAiChatPanel() {
    // Gestione toggle Chat/Note
    var toggleBtns = document.querySelectorAll('#chat-note-toggle .validity-btn');
    var chatPanel = document.getElementById('panel-chat-container');
    var notePanel = document.getElementById('panel-note-container');
    
    if (toggleBtns.length > 0) {
        toggleBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var mode = btn.dataset.mode;
                toggleBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
                
                if (mode === 'chat') {
                    if (chatPanel) chatPanel.classList.remove('hidden');
                    if (notePanel) notePanel.classList.add('hidden');
                } else if (mode === 'note') {
                    if (chatPanel) chatPanel.classList.add('hidden');
                    if (notePanel) notePanel.classList.remove('hidden');
                    refreshNoteListPanel(); // Refresh immediato quando si apre il pannello note
                }
            });
        });
        
        // Carica note all'avvio se la tab note è attiva di default
        var activeBtn = document.querySelector('#chat-note-toggle .validity-btn.active');
        if (activeBtn && activeBtn.dataset.mode === 'note') {
            refreshNoteListPanel();
        }
    }

    var sendBtn = document.getElementById('ai-chat-send');
    var input = document.getElementById('ai-chat-input');
    if (!sendBtn || !input) return;
    ensureAiChatBulkSendButton();
    updateAiChatBulkSendButtonVisibility();
    sendBtn.addEventListener('click', sendAiChatMessage);
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendAiChatMessage();
        }
    });
    appendAiChatMessage('assistant', 'Chat IA pronta. Scrivi una domanda e premi Invia.');
}

// Funzione per caricare e mostrare le note nel pannello laterale
async function refreshNoteListPanel() {
    var container = document.getElementById('note-list-container');
    if (!container) return;
    
    // Se il pannello è nascosto, non fare refresh inutile (salvo primo caricamento o esplicita richiesta)
    if (container.closest('.panel-toggle-content.hidden')) return;

    container.innerHTML = '<div style="color:#888; font-size:0.8rem; text-align:center; padding:1rem;">Caricamento note...</div>';

    try {
        var popupGlobal = document.getElementById('note-prompt-popup');
        if (!popupGlobal) {
            popupGlobal = document.createElement('div');
            popupGlobal.id = 'note-prompt-popup';
            popupGlobal.className = 'note-prompt-popup';
            popupGlobal.setAttribute('role', 'tooltip');
            popupGlobal.setAttribute('aria-hidden', 'true');
            document.body.appendChild(popupGlobal);
        }
        function closeGlobalPromptPopup() {
            popupGlobal.classList.remove('is-visible');
            popupGlobal.setAttribute('aria-hidden', 'true');
            popupGlobal._sourceIcon = null;
        }
        if (!popupGlobal._bound) {
            popupGlobal._bound = true;
            document.addEventListener('click', function (e) {
                if (!popupGlobal.classList.contains('is-visible')) return;
                if (popupGlobal.contains(e.target)) return;
                if (e.target && e.target.classList && e.target.classList.contains('note-prompt-info')) return;
                closeGlobalPromptPopup();
            });
            popupGlobal.addEventListener('click', function (e) { e.stopPropagation(); });
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && popupGlobal.classList.contains('is-visible')) closeGlobalPromptPopup();
            });
            container.addEventListener('scroll', function () {
                if (popupGlobal.classList.contains('is-visible')) closeGlobalPromptPopup();
            });
        }

        var res = await fetch('/api/note'); // Endpoint che ritorna note.json
        // Se non esiste un endpoint specifico /api/note che ritorna tutto il JSON, usiamo la logica esistente
        // In server.js c'è 'note.json' salvato in NOTE_FILE.
        // Verifichiamo se c'è un endpoint GET per le note. Se no, potrebbe servire crearne uno o usare un file read.
        // Per ora assumiamo che nationNote sia disponibile globalmente in script.js (caricato da refreshNationNote)
        
        // Usiamo la variabile globale nationNote popolata da refreshNationNote()
        if (!nationNote || !nationNote.byNation) {
            await refreshNationNote();
        }
        
        var byNation = nationNote.byNation || {};
        var nations = Object.keys(byNation);
        
        container.innerHTML = '';
        
        if (nations.length === 0) {
            container.innerHTML = '<div style="color:#888; font-size:0.8rem; text-align:center; padding:1rem;">Nessuna nota disponibile.</div>';
            return;
        }
        
        // Costruisci lista note mantenendo GA come testo.
        var items = [];
        nations.forEach(function (n) {
            var obj = byNation[n];
            var noteText = '';
            var gaVal = '';
            
            if (typeof obj === 'object') {
                noteText = obj.nota || obj.note || '';
                gaVal = (obj.GA != null) ? String(obj.GA) : ((obj.ga != null) ? String(obj.ga) : '');
            } else if (typeof obj === 'string') {
                noteText = obj;
            }
            
            if (!noteText) return;

            var promptVal = (obj.Prompt != null && String(obj.Prompt).trim() !== '') ? String(obj.Prompt).trim() : (obj.prompt != null && String(obj.prompt).trim() !== '') ? String(obj.prompt).trim() : null;
            items.push({
                nation: n,
                noteText: noteText,
                gaVal: gaVal,
                prompt: promptVal
            });
        });

        // Ordina alfabeticamente per nazione (GA è testuale e non numerica).
        items.sort(function (a, b) {
            return a.nation.localeCompare(b.nation);
        });

        items.forEach(function (item) {
            var div = document.createElement('div');
            div.className = 'note-item';
            
            var headerHtml = '<div class="note-country"><div class="note-country-main"><span class="note-country-name">' + escapeHtml(item.nation) + '</span>';
            if (item.gaVal) {
                headerHtml += '<span class="note-ga">' + escapeHtml(item.gaVal) + '</span>';
            }
            headerHtml += '</div></div>';
            
            var bodyHtml = '<div class="note-text">' + escapeHtml(item.noteText) + '</div>';
            
            div.innerHTML = headerHtml + bodyHtml;
            if (item.prompt) {
                var headerWrap = div.querySelector('.note-country');
                if (headerWrap) {
                    var icon = document.createElement('span');
                    icon.className = 'note-prompt-info';
                    icon.title = 'Suggerimenti sul prompt';
                    icon.setAttribute('aria-label', 'Info prompt');
                    icon.textContent = '\u2139';
                    icon.addEventListener('click', function (e) {
                        e.stopPropagation();
                        var isSameIcon = popupGlobal.classList.contains('is-visible') && popupGlobal._sourceIcon === icon;
                        if (isSameIcon) {
                            closeGlobalPromptPopup();
                            return;
                        }
                        popupGlobal.textContent = item.prompt;
                        popupGlobal.classList.add('is-visible');
                        popupGlobal.setAttribute('aria-hidden', 'false');
                        popupGlobal._sourceIcon = icon;

                        popupGlobal.style.left = '12px';
                        popupGlobal.style.top = '12px';
                        var rect = icon.getBoundingClientRect();
                        var popupWidth = popupGlobal.offsetWidth || 320;
                        var popupHeight = popupGlobal.offsetHeight || 120;

                        var left = rect.right + 10;
                        if (left + popupWidth > window.innerWidth - 12) left = rect.left - popupWidth - 10;
                        if (left < 12) left = 12;
                        if (left + popupWidth > window.innerWidth - 12) left = Math.max(12, window.innerWidth - popupWidth - 12);

                        var top = rect.top - 4;
                        if (top + popupHeight > window.innerHeight - 12) top = Math.max(12, window.innerHeight - popupHeight - 12);
                        if (top < 12) top = 12;

                        popupGlobal.style.left = Math.round(left) + 'px';
                        popupGlobal.style.top = Math.round(top) + 'px';
                    });
                    headerWrap.appendChild(icon);
                }
            }
            container.appendChild(div);
        });

    } catch (e) {
        container.innerHTML = '<div style="color:#f87171; font-size:0.8rem; text-align:center; padding:1rem;">Errore caricamento note.</div>';
        console.error(e);
    }
}

function initSidebarPanels() {
    var tabs = document.querySelectorAll('.sidebar-tab');
    if (!tabs.length) return;
    function setActive(panel) {
        tabs.forEach(function (t) {
            t.classList.toggle('active', t.dataset.panel === panel);
        });
        document.querySelectorAll('[data-panel-section]').forEach(function (el) {
            var p = el.getAttribute('data-panel-section');
            el.classList.toggle('sidebar-panel-hidden', p !== panel);
        });
        if (panel === 'emails') refreshEmailRecipients();
    }
    tabs.forEach(function (t) {
        t.addEventListener('click', function () {
            var p = t.dataset.panel || 'url';
            setActive(p);
        });
    });
    setActive('url');
}

// --- Gestione destinatari email report ---
var emailRecipientsList = [];

function normalizeRecipientItem(raw) {
    var addr = '';
    if (raw && typeof raw === 'object') {
        addr = String(raw.address != null ? raw.address : (raw.email != null ? raw.email : '')).trim();
    }
    if (!addr) return null;
    var type = (raw && raw.type) ? String(raw.type).toLowerCase() : '';
    if (!type) {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
            type = 'email';
        } else if (/^@[\w_]+$/.test(addr) || /^tg:/i.test(addr) || /^telegram:/i.test(addr) || /^-?\d+$/.test(addr)) {
            type = 'telegram';
        } else {
            type = 'email';
        }
    }
    var active = !(raw && raw.active === false);
    var alias = '';
    if (raw && typeof raw === 'object' && raw.alias != null) alias = String(raw.alias).trim();
    return { address: addr, type: type, active: active, alias: alias };
}

function detectRecipientType(addr) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return 'email';
    if (/^@[\w_]+$/.test(addr) || /^tg:/i.test(addr) || /^telegram:/i.test(addr) || /^-?\d+$/.test(addr)) return 'telegram';
    return '';
}

function commitInlineEmailRecipientEdit(index, addrInput, aliasInput) {
    var item = emailRecipientsList[index];
    if (!item) return;
    var newAddr = addrInput ? String(addrInput.value || '').trim() : '';
    var newAlias = aliasInput ? String(aliasInput.value || '').trim() : '';
    if (!newAddr) {
        if (addrInput) addrInput.value = item.address || '';
        if (aliasInput) aliasInput.value = item.alias || '';
        logToConsole('L’indirizzo non può essere vuoto.', 'warn');
        return;
    }
    var newType = detectRecipientType(newAddr);
    if (!newType) {
        if (addrInput) addrInput.value = item.address || '';
        if (aliasInput) aliasInput.value = item.alias || '';
        logToConsole('Inserisci un indirizzo email (nome@dominio) o Telegram valido (es. @username o ID chat).', 'warn');
        return;
    }
    var duplicate = emailRecipientsList.some(function (r, i) {
        if (i === index) return false;
        return (r.address || '').toLowerCase() === newAddr.toLowerCase();
    });
    if (duplicate) {
        if (addrInput) addrInput.value = item.address || '';
        if (aliasInput) aliasInput.value = item.alias || '';
        logToConsole('Indirizzo già presente in lista.', 'warn');
        return;
    }
    var prevAddr = item.address || '';
    var prevAlias = item.alias || '';
    if (prevAddr === newAddr && prevAlias === newAlias && item.type === newType) return;
    item.address = newAddr;
    item.alias = newAlias;
    item.type = newType;
    saveEmailRecipients();
}

async function refreshEmailRecipients() {
    var listEl = document.getElementById('email-recipients-list');
    if (!listEl) return;
    try {
        var res = await fetch('/api/email-recipients');
        var data = await res.json();
        var list = Array.isArray(data) ? data : [];
        emailRecipientsList = [];
        list.forEach(function (item) {
            var norm = normalizeRecipientItem(item);
            if (norm) emailRecipientsList.push(norm);
        });
        renderEmailRecipientsList();
    } catch (e) {
        listEl.innerHTML = '<li style="padding:0.5rem;color:#f87171;font-size:0.8rem;">Errore caricamento indirizzi.</li>';
    }
}

function renderEmailRecipientsList() {
    var listEl = document.getElementById('email-recipients-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (emailRecipientsList.length === 0) {
        var li = document.createElement('li');
        li.style.cssText = 'padding:0.65rem;color:#888;font-size:0.8rem;';
        li.textContent = 'Nessun indirizzo. Inserisci un indirizzo sopra e clicca Aggiungi.';
        listEl.appendChild(li);
        return;
    }
    emailRecipientsList.forEach(function (item, index) {
        var li = document.createElement('li');
        li.className = 'email-recipient-item' + (item.active === false ? ' inactive' : '');
        var toggleWrap = document.createElement('label');
        toggleWrap.className = 'debug-check-wrap';
        toggleWrap.style.marginRight = '0.25rem';
        var toggleSwitch = document.createElement('span');
        toggleSwitch.className = 'toggle-switch';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = item.active !== false;
        cb.addEventListener('change', function () {
            emailRecipientsList[index].active = cb.checked;
            saveEmailRecipients();
        });
        var slider = document.createElement('span');
        slider.className = 'slider';
        toggleSwitch.appendChild(cb);
        toggleSwitch.appendChild(slider);
        toggleWrap.appendChild(toggleSwitch);
        li.appendChild(toggleWrap);
        var addrSpan = document.createElement('span');
        addrSpan.className = 'email-recipient-addr';
        var editWrap = document.createElement('div');
        editWrap.className = 'email-recipient-edit-wrap';
        var addrInput = document.createElement('input');
        addrInput.type = 'text';
        addrInput.className = 'email-recipient-input';
        addrInput.value = item.address || '';
        addrInput.placeholder = 'Email o Telegram';
        var aliasInput = document.createElement('input');
        aliasInput.type = 'text';
        aliasInput.className = 'email-recipient-input';
        aliasInput.value = item.alias || '';
        aliasInput.placeholder = 'Alias (opzionale)';
        addrInput.addEventListener('blur', function () {
            commitInlineEmailRecipientEdit(index, addrInput, aliasInput);
        });
        aliasInput.addEventListener('blur', function () {
            commitInlineEmailRecipientEdit(index, addrInput, aliasInput);
        });
        addrInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addrInput.blur();
            }
        });
        aliasInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                aliasInput.blur();
            }
        });
        editWrap.appendChild(addrInput);
        editWrap.appendChild(aliasInput);
        addrSpan.appendChild(editWrap);
        addrSpan.title = item.active !== false ? 'Attivo' : 'Disattivato';
        li.appendChild(addrSpan);
        var actions = document.createElement('div');
        actions.className = 'email-recipient-actions';
        var btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.textContent = '✕';
        btnDel.title = 'Elimina destinatario';
        btnDel.setAttribute('aria-label', 'Elimina destinatario');
        btnDel.onclick = function () { deleteEmailRecipient(index); };
        actions.appendChild(btnDel);
        li.appendChild(actions);
        listEl.appendChild(li);
    });
}

function addEmailFromInput() {
    var inputEl = document.getElementById('new-email-input');
    var aliasEl = document.getElementById('new-email-alias-input');
    var value = inputEl ? String(inputEl.value || '').trim() : '';
    var alias = aliasEl ? String(aliasEl.value || '').trim() : '';
    if (!value) return;
    var addr = value;
    var type = detectRecipientType(addr);
    if (!type) {
        logToConsole('Inserisci un indirizzo email (nome@dominio) o Telegram valido (es. @username o ID chat).', 'warn');
        return;
    }
    var exists = emailRecipientsList.some(function (r) {
        return (r.address || '').toLowerCase() === addr.toLowerCase();
    });
    if (exists) {
        logToConsole('Indirizzo già presente in lista.', 'warn');
        return;
    }
    emailRecipientsList.push({ address: addr, type: type, active: true, alias: alias });
    if (inputEl) inputEl.value = '';
    if (aliasEl) aliasEl.value = '';
    saveEmailRecipients();
}

function addEmailRecipient() {
    var inputEl = document.getElementById('new-email-input');
    if (inputEl && String(inputEl.value || '').trim()) {
        addEmailFromInput();
        return;
    }
    var addr = prompt('Indirizzo email o Telegram da aggiungere:');
    if (addr == null) return;
    addr = String(addr || '').trim();
    if (!addr) return;
    var type = detectRecipientType(addr);
    if (!type) {
        alert('Inserisci un indirizzo email (nome@dominio) o Telegram valido (es. @username o ID chat).');
        return;
    }
    var exists = emailRecipientsList.some(function (r) {
        return (r.address || '').toLowerCase() === addr.toLowerCase();
    });
    if (exists) {
        alert('Questo indirizzo è già presente.');
        return;
    }
    var alias = prompt('Alias (opzionale):');
    if (alias == null) return;
    emailRecipientsList.push({ address: addr, type: type, active: true, alias: String(alias || '').trim() });
    saveEmailRecipients();
}

function editEmailRecipient(index) {
    var item = emailRecipientsList[index];
    if (!item) return;
    var current = item.address || '';
    var currentAlias = item.alias || '';
    var addr = prompt('Modifica indirizzo (email o Telegram):', current);
    if (addr == null) return;
    addr = String(addr || '').trim();
    if (!addr) return;
    var type = detectRecipientType(addr);
    if (!type) {
        alert('Inserisci un indirizzo email (nome@dominio) o Telegram valido (es. @username o ID chat).');
        return;
    }
    var other = emailRecipientsList.filter(function (_, i) { return i !== index; });
    if (other.some(function (r) { return (r.address || '').toLowerCase() === addr.toLowerCase(); })) {
        alert('Questo indirizzo è già presente.');
        return;
    }
    var alias = prompt('Alias (opzionale):', currentAlias);
    if (alias == null) return;
    alias = String(alias || '').trim();
    emailRecipientsList[index].address = addr;
    emailRecipientsList[index].type = type;
    emailRecipientsList[index].alias = alias;
    saveEmailRecipients();
}

function deleteEmailRecipient(index) {
    if (!window.confirm('Rimuovere questo indirizzo dalla lista?')) return;
    emailRecipientsList.splice(index, 1);
    saveEmailRecipients();
}

async function saveEmailRecipients() {
    try {
        var res = await fetch('/api/email-recipients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ list: emailRecipientsList })
        });
        var data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Errore salvataggio');
        if (Array.isArray(data.list)) {
            emailRecipientsList = [];
            data.list.forEach(function (item) {
                var norm = normalizeRecipientItem(item);
                if (norm) emailRecipientsList.push(norm);
            });
        }
        renderEmailRecipientsList();
        logToConsole('Lista destinatari report aggiornata.', 'success');
    } catch (e) {
        logToConsole('Errore salvataggio destinatari report: ' + e.message, 'error');
    }
}

async function refreshJsonFolders() {
    try {
        var res = await fetch('/api/json-folders');
        var data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Errore API');
        jsonFolderState.folders = Array.isArray(data.folders) ? data.folders : [];
        jsonFolderState.active = data.active || '';
        var label = document.getElementById('json-active-folder-label');
        if (label) label.textContent = jsonFolderState.active ? jsonFolderState.active : 'Principale';
        updateAppTitleFolderSuffix();
        var list = document.getElementById('json-folder-list');
        if (!list) return;
        list.innerHTML = '';
        jsonFolderState.folders.forEach(function (name) {
            var li = document.createElement('li');
            li.className = 'folder-item' + (name === jsonFolderState.active ? ' active' : '');
            var span = document.createElement('span');
            span.className = 'folder-name';
            span.textContent = name;
            span.onclick = function () {
                if (elaborationInProgress) {
                    logToConsole('Cambio cartella Json bloccato: elaborazione in corso. Premi STOP prima di cambiare cartella.', 'warn');
                    return;
                }
                setActiveJsonFolder(name);
            };
            li.appendChild(span);
            var btnCopy = document.createElement('button');
            btnCopy.type = 'button';
            btnCopy.textContent = 'Copia in...';
            btnCopy.onclick = function (e) {
                e.stopPropagation();
                copyJsonFolderContents(name);
            };
            li.appendChild(btnCopy);
            var btnRename = document.createElement('button');
            btnRename.type = 'button';
            btnRename.textContent = 'Rinomina';
            btnRename.onclick = function (e) {
                e.stopPropagation();
                renameJsonFolder(name);
            };
            li.appendChild(btnRename);
            var btnDel = document.createElement('button');
            btnDel.type = 'button';
            btnDel.textContent = 'Elimina';
            btnDel.onclick = function (e) {
                e.stopPropagation();
                deleteJsonFolder(name);
            };
            li.appendChild(btnDel);
            list.appendChild(li);
        });
    } catch (e) {
        logToConsole('Errore caricamento cartelle Json: ' + e.message, 'error');
    }
}

async function createJsonFolder() {
    var today = new Date();
    var yyyy = today.getFullYear();
    var mm = String(today.getMonth() + 1).padStart(2, '0');
    var dd = String(today.getDate()).padStart(2, '0');
    var suggested = yyyy + '-' + mm + '-' + dd;
    var name = prompt('Nome nuova cartella (solo lettere, numeri, _ e -):', suggested);
    if (!name) return;
    name = String(name).trim();
    if (!/^[a-zA-Z0-9_\-]+$/.test(name)) {
        alert('Nome non valido.');
        return;
    }
    try {
        var res = await fetch('/api/json-folders/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
        });
        var data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Errore API');
        await refreshJsonFolders();
    } catch (e) {
        logToConsole('Errore creazione cartella Json: ' + e.message, 'error');
    }
}

async function renameJsonFolder(oldName) {
    var to = prompt('Nuovo nome per la cartella "' + oldName + '" (solo lettere, numeri, _ e -):', oldName);
    if (!to || to === oldName) return;
    to = String(to).trim();
    if (!/^[a-zA-Z0-9_\-]+$/.test(to)) {
        alert('Nome non valido.');
        return;
    }
    try {
        var res = await fetch('/api/json-folders/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: oldName, to: to })
        });
        var data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Errore API');
        await refreshJsonFolders();
    } catch (e) {
        logToConsole('Errore rinomina cartella Json: ' + e.message, 'error');
    }
}

async function deleteJsonFolder(name) {
    if (!confirm('Eliminare definitivamente la cartella "' + name + '" e tutti i JSON al suo interno?')) return;
    try {
        var res = await fetch('/api/json-folders/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
        });
        var data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Errore API');
        await refreshJsonFolders();
    } catch (e) {
        logToConsole('Errore eliminazione cartella Json: ' + e.message, 'error');
    }
}

async function copyJsonFolderContents(fromName) {
    var to = prompt('Copia contenuti di "' + fromName + '" nella cartella (nome destinazione):', fromName);
    if (!to || to === fromName) return;
    to = String(to).trim();
    if (!/^[a-zA-Z0-9_\-]+$/.test(to)) {
        alert('Nome non valido.');
        return;
    }
    try {
        var res = await fetch('/api/json-folders/copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: fromName, to: to })
        });
        var data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Errore API');
        await refreshJsonFolders();
        logToConsole('Contenuti copiati da "' + fromName + '" a "' + to + '".', 'info');
    } catch (e) {
        logToConsole('Errore copia cartella Json: ' + e.message, 'error');
    }
}

async function setActiveJsonFolder(name) {
    try {
        try { await saveFolderSettings(); } catch (_) {}
        var res = await fetch('/api/json-folders/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name || '' })
        });
        var data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Errore API');
        jsonFolderState.active = data.active || '';
        await refreshJsonFolders();
        updateAppTitleFolderSuffix();
        try {
            await loadFolderSettings();
        } catch (settingsErr) {
            logToConsole('Errore caricamento impostazioni cartella: ' + settingsErr.message, 'error');
        }
        logToConsole('Cartella Json attiva: ' + (jsonFolderState.active || 'Principale') + '. Ricarico dati da nuova cartella...', 'info');
        // Ricarica immediatamente i dati principali dalla nuova cartella Json attiva
        try {
            await updateArticolielaboratiCountDisplay();
            await refreshNationSintesi();
            await refreshNationAggregate();
            await refreshNationSintesiAlternativa();
            await refreshNationEmwaIa();
            await refreshNationSintesiIaPesata();
            await refreshNationNote();
            await refreshNationSintesiV4();
            await refreshNationSintesiV5();
            await refreshSintesiVRed();
            await refreshAcceptedList();
            await refreshNoteListPanel(); // Aggiorna anche la lista note
            applyAcceptedListVisibility();
        } catch (innerErr) {
            logToConsole('Errore ricarica dati dopo cambio cartella: ' + innerErr.message, 'error');
        }
    } catch (e) {
        logToConsole('Errore impostazione cartella Json attiva: ' + e.message, 'error');
    }
}

function formatAcceptedDate(item) {
    var raw = item && (item.timestamp || item.date || item.data);
    if (!raw) return '-';
    var d = new Date(raw);
    if (!isNaN(d.getTime())) {
        return d.toLocaleString('it-IT', { hour12: false });
    }
    return String(raw);
}

var acceptedViewMode = 'accettati';
var lastAcceptedSnapshot = { accettati: '', scartati: '', errori: '' };

function applyAcceptedListVisibility() {
    var acc = document.getElementById('accepted-list-accettati');
    var sca = document.getElementById('accepted-list-scartati');
    var err = document.getElementById('accepted-list-errori');
    if (!acc || !sca || !err) return;
    var showScartati = acceptedViewMode === 'scartati';
    var showErrori = acceptedViewMode === 'errori';
    acc.classList.toggle('hidden', showScartati || showErrori);
    sca.classList.toggle('hidden', !showScartati);
    err.classList.toggle('hidden', !showErrori);
}

async function refreshAcceptedList() {
    var acceptedBox = document.getElementById('accepted-list-accettati');
    var scartatiBox = document.getElementById('accepted-list-scartati');
    var erroriBox = document.getElementById('accepted-list-errori');
    if (!acceptedBox || !scartatiBox || !erroriBox) return;
    // Salva posizione di scroll per evitare salti visivi al refresh
    var prevAccScroll = acceptedBox.scrollTop;
    var prevScaScroll = scartatiBox.scrollTop;
    var prevErrScroll = erroriBox.scrollTop;
    try {
        var acceptedRes = await fetch('/api/accettati');
        var scartatiRes = await fetch('/api/scartati');
        var erroriRes = await fetch('/api/errori');
        var acceptedCt = String(acceptedRes.headers.get('content-type') || '').toLowerCase();
        var scartatiCt = String(scartatiRes.headers.get('content-type') || '').toLowerCase();
        var erroriCt = String(erroriRes.headers.get('content-type') || '').toLowerCase();
        if (!acceptedRes.ok) throw new Error('HTTP ' + acceptedRes.status + ' su /api/accettati.');
        if (!scartatiRes.ok) throw new Error('HTTP ' + scartatiRes.status + ' su /api/scartati.');
        if (!erroriRes.ok) throw new Error('HTTP ' + erroriRes.status + ' su /api/errori.');
        if (acceptedCt.indexOf('application/json') === -1) throw new Error('Risposta non JSON da /api/accettati.');
        if (scartatiCt.indexOf('application/json') === -1) throw new Error('Risposta non JSON da /api/scartati.');
        if (erroriCt.indexOf('application/json') === -1) throw new Error('Risposta non JSON da /api/errori.');

        var acceptedData = await acceptedRes.json();
        var scartatiData = await scartatiRes.json();
        var erroriData = await erroriRes.json();
        if (!Array.isArray(acceptedData)) acceptedData = [];
        if (!Array.isArray(scartatiData)) scartatiData = [];
        if (!Array.isArray(erroriData)) erroriData = [];

        // Costruisci snapshot logico per scartati
        var scView = [];
        for (var j = scartatiData.length - 1; j >= 0; j--) {
            var sc0 = scartatiData[j] || {};
            scView.push({
                url: sc0.url || sc0.link || null,
                title: sc0.title || sc0.titolo || null,
                ts: sc0.timestamp || sc0.date || sc0.data || null,
                reason: sc0.reason || (sc0.meta && sc0.meta.reason) || null,
                nota: sc0.nota || (sc0.meta && sc0.meta.nota) || null
            });
        }
        var scSnap = JSON.stringify(scView);

        // Costruisci snapshot logico per errori (solo question_per_article, ecc.)
        var errView = [];
        for (var eIdx = erroriData.length - 1; eIdx >= 0; eIdx--) {
            var er0 = erroriData[eIdx] || {};
            errView.push({
                url: er0.url || null,
                title: er0.title || null,
                ts: er0.timestamp || null,
                reason: er0.reason || '',
                stage: er0.stage || ''
            });
        }
        var errSnap = JSON.stringify(errView);

        // Costruisci snapshot logico per accettati (deduplicati, con flag fase2)
        var accSnapArr = [];
        if (acceptedData.length === 0) {
            accSnapArr = [];
        } else {
            // Modalità ACCETTATI: deduplica per link e marca Fase 1B / Fase 2
            var byLink = {};
            for (var i = 0; i < acceptedData.length; i++) {
                var it = acceptedData[i] || {};
                var link = it.link || it.url;
                if (!link) continue;
                if (!byLink[link]) {
                    byLink[link] = Object.assign({}, it);
                } else {
                    var existing = byLink[link];
                    if (!existing.nota && it.nota) existing.nota = it.nota;
                    var dOld = new Date(existing.timestamp || existing.date || existing.data || 0);
                    var dNew = new Date(it.timestamp || it.date || it.data || 0);
                    if (dNew > dOld) {
                        existing.timestamp = it.timestamp || it.date || it.data || existing.timestamp;
                    }
                    byLink[link] = existing;
                }
            }
            var merged = Object.keys(byLink).map(function (k) { return byLink[k]; });
            merged.sort(function (a, b) {
                var da = new Date(a.timestamp || a.date || a.data || 0);
                var db = new Date(b.timestamp || b.date || b.data || 0);
                return db - da;
            });

            var analyzedUrls = new Set();
            try {
                var resArt = await fetch('/api/articolielaborati');
                var ctArt = String(resArt.headers.get('content-type') || '').toLowerCase();
                if (resArt.ok && ctArt.indexOf('application/json') !== -1) {
                    var artData = await resArt.json();
                    if (Array.isArray(artData)) {
                        for (var k = 0; k < artData.length; k++) {
                            var e = artData[k] || {};
                            if (Array.isArray(e.response) && e.url) analyzedUrls.add(e.url);
                        }
                    }
                }
            } catch (_) {}

            merged.forEach(function (item) {
                var link = item.link || item.url || null;
                var isFase2 = link && analyzedUrls.has(link);
                accSnapArr.push({
                    url: link,
                    title: item.titolo || item.title || null,
                    ts: item.timestamp || item.date || item.data || null,
                    nota: item.nota || null,
                    fase2: !!isFase2
                });
            });
        }
        var accSnap = JSON.stringify(accSnapArr);

        // Se nulla è cambiato rispetto all'ultimo snapshot, non toccare il DOM (evita sfarfallio)
        if (lastAcceptedSnapshot.accettati === accSnap && lastAcceptedSnapshot.scartati === scSnap && lastAcceptedSnapshot.errori === errSnap) {
            applyAcceptedListVisibility();
            // Ripristina scroll (non modificato, ma per sicurezza)
            acceptedBox.scrollTop = prevAccScroll;
            scartatiBox.scrollTop = prevScaScroll;
            erroriBox.scrollTop = prevErrScroll;
            return;
        }
        lastAcceptedSnapshot.accettati = accSnap;
        lastAcceptedSnapshot.scartati = scSnap;
        lastAcceptedSnapshot.errori = errSnap;

        // (Ri)costruisci il DOM solo quando lo snapshot varia
        acceptedBox.innerHTML = '';
        scartatiBox.innerHTML = '';
        erroriBox.innerHTML = '';

        if (scView.length === 0) {
            var scEmpty = document.createElement('div');
            scEmpty.className = 'accepted-meta';
            scEmpty.textContent = 'Nessun articolo scartato.';
            scartatiBox.appendChild(scEmpty);
        } else {
            scView.forEach(function (sc) {
                var sCard = document.createElement('div');
                sCard.className = 'accepted-item scartato-item';

                var sTitle = document.createElement('div');
                sTitle.className = 'accepted-title';
                sTitle.textContent = String(sc.title || sc.url || 'Articolo');

                var sMeta = document.createElement('div');
                sMeta.className = 'accepted-meta';
                var reason = String(sc.reason || '-');
                sMeta.textContent = 'Data: ' + formatAcceptedDate({ timestamp: sc.ts }) + ' — Motivo: ' + reason;

                var sNote = document.createElement('div');
                sNote.className = 'accepted-note';
                sNote.textContent = 'Nota: ' + String(sc.nota || '-');

                sCard.appendChild(sTitle);
                sCard.appendChild(sMeta);
                sCard.appendChild(sNote);
                scartatiBox.appendChild(sCard);
            });
        }

        if (accSnapArr.length === 0) {
            var acEmpty = document.createElement('div');
            acEmpty.className = 'accepted-meta';
            acEmpty.textContent = 'Nessun articolo accettato.';
            acceptedBox.appendChild(acEmpty);
        } else {
            accSnapArr.forEach(function (item) {
                var card = document.createElement('div');
                card.className = 'accepted-item ' + (item.fase2 ? 'accepted-fase2' : 'accepted-fase1');

                var title = document.createElement('div');
                title.className = 'accepted-title';
                title.textContent = String(item.title || item.url || 'Articolo');

                var meta = document.createElement('div');
                meta.className = 'accepted-meta';
                var stato = item.fase2 ? 'Analizzato (Fase 2)' : 'Pertinente (Fase 1B)';
                meta.textContent = 'Data: ' + formatAcceptedDate({ timestamp: item.ts }) + ' — Stato: ' + stato;

                var note = document.createElement('div');
                note.className = 'accepted-note';
                note.textContent = 'Note: ' + String(item.nota || '-');

                card.appendChild(title);
                card.appendChild(meta);
                card.appendChild(note);
                acceptedBox.appendChild(card);
            });
        }

        // Render lista errori
        if (errView.length === 0) {
            var erEmpty = document.createElement('div');
            erEmpty.className = 'accepted-meta';
            erEmpty.textContent = 'Nessun errore IA registrato.';
            erroriBox.appendChild(erEmpty);
        } else {
            errView.forEach(function (er) {
                var eCard = document.createElement('div');
                eCard.className = 'accepted-item scartato-item';

                var eTitle = document.createElement('div');
                eTitle.className = 'accepted-title';
                eTitle.textContent = String(er.title || er.url || 'Articolo');

                var eMeta = document.createElement('div');
                eMeta.className = 'accepted-meta';
                var reason = String(er.reason || '-');
                var stage = er.stage ? (' — Stage: ' + er.stage) : '';
                eMeta.textContent = 'Data: ' + formatAcceptedDate({ timestamp: er.ts }) + ' — Motivo: ' + reason + stage;

                eCard.appendChild(eTitle);
                eCard.appendChild(eMeta);
                erroriBox.appendChild(eCard);
            });
        }

        applyAcceptedListVisibility();
        // Ripristina posizione di scroll dopo il rerender
        acceptedBox.scrollTop = prevAccScroll;
        scartatiBox.scrollTop = prevScaScroll;
        applyAcceptedListVisibility();
    } catch (e) {
        acceptedBox.innerHTML = '';
        scartatiBox.innerHTML = '';
        var errAcc = document.createElement('div');
        errAcc.className = 'accepted-meta';
        errAcc.textContent = 'Errore caricamento liste: ' + e.message + ' (riavvia il backend).';
        var errSca = errAcc.cloneNode(true);
        acceptedBox.appendChild(errAcc);
        scartatiBox.appendChild(errSca);
        applyAcceptedListVisibility();
    }
}

function getYoutubeVideoIdFromUrl(urlLike) {
    try {
        if (!urlLike) return null;
        var u = new URL(urlLike, window.location.origin);
        var host = (u.hostname || '').toLowerCase();
        if (host.indexOf('youtu.be') !== -1) {
            var p = (u.pathname || '').replace(/^\/+/, '');
            return p ? p.split('/')[0] : null;
        }
        if (host.indexOf('youtube.com') !== -1) {
            var v = u.searchParams.get('v');
            if (v) return v;
            var parts = (u.pathname || '').split('/').filter(Boolean);
            if (parts.length >= 2 && (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed')) return parts[1];
        }
    } catch (e) {}
    return null;
}

// Logger function for UI
function logToConsole(message, type = 'info') {
    const consoleOutput = document.getElementById('console-output');
    if (!consoleOutput) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry log-' + (type || 'info');
    
    const now = new Date();
    const timeStr = now.toLocaleTimeString('it-IT', { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' });
    
    var safe = String(message || '');
    var div = document.createElement('div');
    div.textContent = safe;
    safe = div.innerHTML;
    entry.innerHTML = '<span class="timestamp">[' + timeStr + ']</span> <span class="log-message">' + safe + '</span>';
    entry.querySelector('.log-message').style.whiteSpace = 'pre-wrap';
    entry.querySelector('.log-message').style.wordBreak = 'break-word';
    consoleOutput.appendChild(entry);
    
    // Auto scroll to bottom
    const panel = document.querySelector('.console-panel');
    panel.scrollTop = panel.scrollHeight;
}

// Load URLs on startup
async function loadUrls() {
    logToConsole('Inizializzazione sistema...', 'info');
    try {
        const res = await fetch('/api/urls');
        urlList = await res.json();
        if (!Array.isArray(urlList)) urlList = [];
        urlList.forEach(function (item) {
            if (item && typeof item.pageUpTo !== 'number') item.pageUpTo = 0;
            if (item && item.type === 'telegram') item.pageUpTo = 0;
        });
        urlsLoaded = true; // Mark as loaded
        renderList();
        logToConsole(`Caricati ${urlList.length} URL.`, 'success');
    } catch (e) {
        console.error("Failed to load URLs", e);
        logToConsole('Errore nel caricamento degli URL. Salvataggio disabilitato per sicurezza.', 'error');
        urlsLoaded = false;
    }
}

// Riconoscimento tipo da URL: default Blog; Telegram; YouTube; RSS se feed/rss/atom o .xml
function detectUrlType(url) {
    if (!url || typeof url !== 'string') return 'blog';
    var u = url.trim().toLowerCase();
    if (/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me)\//i.test(u)) return 'telegram';
    if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(u)) return 'youtube';
    if (/\.xml(\?|$)/i.test(u)) return 'rss';
    if (/\/rss\//.test(u)) return 'rss';
    if (/\/feed\//.test(u)) return 'rss';
    if (/\/feed-rss\//.test(u)) return 'rss';
    return 'blog';
}

function applyTypeFromUrl(index) {
    if (index < 0 || index >= urlList.length) return;
    var item = urlList[index];
    item.type = detectUrlType(item.url || '');
    if (item.type === 'telegram') item.pageUpTo = 0;
    if (item.type === 'rss') item.pageUpTo = 1;
}

function getTypeLabel(type) {
    if (type === 'telegram') return 'Telegram';
    if (type === 'youtube') return 'YouTube';
    if (type === 'rss') return 'RSS';
    return 'Blog';
}

// Normalizza una data RSS in formato YYYY-MM-DD (se possibile).
// Supporta:
// - Formati RFC2822/RFC1123 es. "Tue, 10 Mar 2026 07:00:02 +0100"
// - Formati ISO o simili parseabili da new Date(...)
function normalizeRssDateString(s) {
    if (!s || typeof s !== 'string') {
        return new Date().toISOString().slice(0, 10);
    }
    var str = s.trim();
    if (!str) {
        return new Date().toISOString().slice(0, 10);
    }
    // Prima prova con Date standard (gestisce già bene "Tue, 10 Mar 2026 07:00:02 +0100")
    var d = new Date(str);
    if (!isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10);
    }
    // Fallback minimale: pattern "10 Mar 2026" (mesi inglesi a 3+ lettere)
    var m = str.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
    if (m) {
        var day = parseInt(m[1], 10);
        var monthName = m[2].toLowerCase();
        var year = parseInt(m[3], 10);
        var months = {
            jan: 1, january: 1,
            feb: 2, february: 2,
            mar: 3, march: 3,
            apr: 4, april: 4,
            may: 5,
            jun: 6, june: 6,
            jul: 7, july: 7,
            aug: 8, august: 8,
            sep: 9, sept: 9, september: 9,
            oct: 10, october: 10,
            nov: 11, november: 11,
            dec: 12, december: 12
        };
        var key = monthName.slice(0, 3);
        var month = months[monthName] || months[key] || null;
        if (month && day && year) {
            var mm = month < 10 ? '0' + month : '' + month;
            var dd = day < 10 ? '0' + day : '' + day;
            return year + '-' + mm + '-' + dd;
        }
    }
    // Se tutto fallisce, usa oggi per evitare valori vuoti
    return new Date().toISOString().slice(0, 10);
}

// Render the list of inputs
function renderList() {
    const list = document.getElementById('url-list');
    list.innerHTML = '';

    var filter = (urlFilter || '').trim().toLowerCase();

    urlList.forEach((item, index) => {
        var url = (item.url || '').toLowerCase();
        var title = (item.title || '').toLowerCase();
        if (filter && url.indexOf(filter) === 0 === false && url.indexOf(filter) === -1 && title.indexOf(filter) === -1) {
            return;
        }
        var type = (item.type === 'telegram' || item.type === 'youtube' || item.type === 'rss') ? item.type : 'blog';
        var typeLabel = getTypeLabel(type);
        var pageUpTo = typeof item.pageUpTo === 'number' ? item.pageUpTo : 0;

        const li = document.createElement('li');
        li.className = 'url-item';
        
        // Active Toggle (Custom Switch)
        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'toggle-switch';
        
        const toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.checked = item.active !== false;
        toggleInput.onchange = (e) => updateActive(index, e.target.checked);
        
        const sliderSpan = document.createElement('span');
        sliderSpan.className = 'slider';
        
        toggleLabel.appendChild(toggleInput);
        toggleLabel.appendChild(sliderSpan);

        // Tipo riconosciuto (affianco al check) — badge in stile pagina
        const typeSpan = document.createElement('span');
        typeSpan.className = 'url-type-label url-type--' + type;
        typeSpan.textContent = typeLabel;
        typeSpan.title = 'Tipo riconosciuto da URL';

        // Select "giorni/pagine" (solo per Blog; RSS = un solo feed, no select pagine)
        let pageSelect = null;
        if (type === 'blog') {
            pageSelect = document.createElement('select');
            pageSelect.className = 'url-page-select';
            pageSelect.title = 'Numero di pagine/giorni da analizzare';
            for (var v = 0; v <= 9; v++) {
                var opt = document.createElement('option');
                opt.value = String(v);
                opt.textContent = (v === 0 ? '-' : String(v));
                if (v === pageUpTo) opt.selected = true;
                pageSelect.appendChild(opt);
            }
            pageSelect.onchange = function (e) {
                var n = parseInt(e.target.value, 10);
                if (isNaN(n)) n = 0;
                updatePageUpTo(index, n);
            };
        }

        // Input
        const input = document.createElement('input');
        input.type = 'text';
        input.value = item.url || '';
        input.placeholder = 'Inserisci URL...';
        input.onchange = (e) => updateUrl(index, e.target.value);

        // Drag Handle
        const dragHandle = document.createElement('span');
        dragHandle.className = 'url-drag-handle';
        dragHandle.draggable = true;
        dragHandle.title = 'Trascina per riordinare';
        dragHandle.innerHTML = '⋮⋮';
        dragHandle.setAttribute('data-index', index);

        // Delete Button
        const delBtn = document.createElement('button');
        delBtn.textContent = '✖';
        delBtn.className = 'icon-btn danger';
        delBtn.onclick = () => deleteUrl(index);

        li.setAttribute('data-index', index);
        li.appendChild(toggleLabel);
        li.appendChild(typeSpan);
        if (pageSelect) li.appendChild(pageSelect);
        li.appendChild(input);
        li.appendChild(dragHandle);
        li.appendChild(delBtn);
        list.appendChild(li);
    });
    updateSelectAllButtonText();
}

function addUrl() {
    urlList.push({ url: '', type: 'blog', active: true, pageUpTo: 0 });
    renderList();
    logToConsole('Nuovo URL aggiunto.', 'info');
}

function updateUrl(index, value) {
    if (index < 0 || index >= urlList.length) return;
    urlList[index].url = value;
    applyTypeFromUrl(index);
    renderList();
    saveUrls();
}

function updateType(index, value) {
    if (index < 0 || index >= urlList.length) return;
    urlList[index].type = (value === 'telegram' || value === 'youtube' || value === 'rss') ? value : 'blog';
    if (urlList[index].type === 'telegram') urlList[index].pageUpTo = 0;
    if (urlList[index].type === 'rss') urlList[index].pageUpTo = 1;
    saveUrls();
}

function updatePageUpTo(index, value) {
    if (index < 0 || index >= urlList.length) return;
    urlList[index].pageUpTo = (value >= 0 && value <= 9) ? value : 0;
    saveUrls();
}

function updateActive(index, value) {
    urlList[index].active = value;
    saveUrls();
    updateSelectAllButtonText();
}

function allUrlsActive() {
    if (!urlList.length) return true;
    return urlList.every(function (item) { return item.active !== false; });
}

function updateSelectAllButtonText() {
    var btn = document.getElementById('select-all-urls-btn');
    if (!btn) return;
    if (!urlList.length) { btn.textContent = 'Select All'; return; }
    btn.textContent = allUrlsActive() ? 'Deselect All' : 'Select All';
}

function toggleSelectAllUrls() {
    if (!urlList.length) return;
    var setActive = !allUrlsActive();
    for (var i = 0; i < urlList.length; i++) urlList[i].active = setActive;
    renderList();
    saveUrls();
    updateSelectAllButtonText();
}

function deleteUrl(index) {
    urlList.splice(index, 1);
    renderList();
    saveUrls();
    logToConsole('URL rimosso.', 'warn');
}

function moveUrl(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= urlList.length || toIndex >= urlList.length) return;
    var item = urlList.splice(fromIndex, 1)[0];
    urlList.splice(toIndex, 0, item);
    renderList();
    saveUrls();
}

function initUrlDragDrop() {
    var list = document.getElementById('url-list');
    if (!list) return;
    list.addEventListener('dragstart', function(e) {
        var handle = e.target.closest('.url-drag-handle');
        if (!handle) return;
        var li = handle.closest('.url-item');
        if (!li) return;
        e.dataTransfer.setData('text/plain', li.getAttribute('data-index'));
        e.dataTransfer.effectAllowed = 'move';
        li.classList.add('url-dragging');
    });
    list.addEventListener('dragend', function(e) {
        var li = e.target.closest('.url-item');
        if (li) li.classList.remove('url-dragging');
    });
    list.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        var li = e.target.closest('.url-item');
        list.querySelectorAll('.url-drag-over').forEach(function(el) { el.classList.remove('url-drag-over'); });
        if (li && !li.classList.contains('url-dragging')) li.classList.add('url-drag-over');
    });
    list.addEventListener('dragleave', function(e) {
        if (!e.target.closest('.url-item')) return;
        var next = e.relatedTarget;
        if (!next || !list.contains(next) || !next.closest('.url-item')) {
            list.querySelectorAll('.url-drag-over').forEach(function(el) { el.classList.remove('url-drag-over'); });
        }
    });
    list.addEventListener('drop', function(e) {
        e.preventDefault();
        var targetLi = e.target.closest('.url-item');
        if (!targetLi) return;
        targetLi.classList.remove('url-drag-over');
        var fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
        var toIndex = parseInt(targetLi.getAttribute('data-index'), 10);
        if (isNaN(fromIndex) || isNaN(toIndex)) return;
        moveUrl(fromIndex, toIndex);
    });
}

function setUrlFilter(value) {
    urlFilter = (value || '').toLowerCase();
    renderList();
}

function getPageNumberFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    var m = url.match(/\/page\/(\d+)/i) || url.match(/\/p\/(\d+)/i) || url.match(/[?&]page=(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

function setPageInUrl(url, page) {
    if (!url || typeof url !== 'string' || page == null) return url;
    var n = String(page);
    if (/\/page\/\d+/i.test(url)) return url.replace(/\/page\/\d+/i, '/page/' + n);
    if (/\/p\/\d+/i.test(url)) return url.replace(/\/p\/\d+/i, '/p/' + n);
    if (url.match(/[?&]page=\d+/i)) return url.replace(/([?&]page=)\d+/i, '$1' + n);
    if (url.indexOf('?') !== -1) return url + '&page=' + n;
    return url + (url.indexOf('?') !== -1 ? '&' : '?') + 'page=' + n;
}

// Sostituisce @ nell'URL in base al numero pagina (select "Pagine").
// Pagina 1: index_@ -> index; pagina 2,3,...: @ -> 2, 3, 4, ...
function substituteAtInUrl(url, page) {
    if (!url || typeof url !== 'string' || !url.includes('@')) return url;
    if (page === 1) {
        return url.replace(/index_@/gi, 'index');
    }
    return url.replace(/@/g, String(page));
}

function expandUrlListForPages(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (item.active === false) continue;
        var type = item.type || 'blog';
        var pageUpTo = typeof item.pageUpTo === 'number' && item.pageUpTo >= 1 && item.pageUpTo <= 9 ? item.pageUpTo : 0;

        if (type === 'telegram') {
            out.push({ url: item.url, type: type, active: true });
            continue;
        }

        if (type === 'rss') {
            out.push({ url: item.url, type: type, active: true });
            continue;
        }

        // Per i Blog: pageUpTo = 0 (opzione "-") significa "non elaborare questo URL"
        if (type === 'blog' && pageUpTo === 0) {
            continue;
        }

        // URL con @: sostituzione in base a pagine (1 -> index, 2->index_2, ...)
        if (typeof item.url === 'string' && item.url.includes('@')) {
            if (pageUpTo === 0) {
                out.push({ url: substituteAtInUrl(item.url, 1), type: type, active: true });
                continue;
            }
            for (var p = 1; p <= pageUpTo; p++) {
                out.push({ url: substituteAtInUrl(item.url, p), type: type, active: true });
            }
            continue;
        }

        if (pageUpTo === 0) {
            out.push({ url: item.url, type: type, active: true });
            continue;
        }
        var currentPage = getPageNumberFromUrl(item.url);
        if (currentPage == null) {
            out.push({ url: item.url, type: type, active: true });
            continue;
        }
        var lastPage = Math.min(pageUpTo, 99);
        for (var p = currentPage; p <= lastPage; p++) {
            out.push({ url: setPageInUrl(item.url, p), type: type, active: true });
        }
    }
    return out;
}

function normalizeArticleUrlForDedup(urlLike) {
    if (!urlLike) return '';
    try {
        var u = new URL(String(urlLike), window.location.origin);
        u.hash = '';
        // Normalizza slash finale e query tracking comuni per evitare duplicati fittizi
        var pathname = (u.pathname || '').replace(/\/+$/, '') || '/';
        u.pathname = pathname;
        ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'].forEach(function (k) {
            u.searchParams.delete(k);
        });
        return u.toString();
    } catch (e) {
        return String(urlLike || '').trim().replace(/\/+$/, '');
    }
}

function normalizeTelegramTextForKey(text) {
    if (!text) return '';
    return String(text)
        .replace(/https?:\/\/[^\s]+/g, ' ')
        .replace(/www\.[^\s]+/g, ' ')
        .replace(/(?:t\.me|telegram\.me)\/[^\s]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function hashStringFNV1a(input) {
    var s = String(input || '');
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
}

function buildTelegramStableArticleUrl(sourceUrl, rawPostUrl, text, dateStr, fallbackIdx, linkvideo) {
    var directPost = String(rawPostUrl || '').trim();
    if (/^https?:\/\/(?:t\.me|telegram\.me)\//i.test(directPost)) {
        return directPost.replace(/[:.,;!?#]+(\/?)$/, '$1');
    }
    var source = String(sourceUrl || '').trim().replace(/\/+$/, '');
    if (!source) source = 'https://telegram.local';
    var datePart = String(dateStr || '').trim();
    var textPart = normalizeTelegramTextForKey(text).slice(0, 1200);
    var keyMaterial = source + '|' + datePart + '|' + textPart + '|' + String(fallbackIdx || '');
    var hash = hashStringFNV1a(keyMaterial);
    return 'https://telegram.local/post/' + hash;
}

var runHistoryDedupContext = null;
function setRunHistoryDedupContext(ctx) {
    runHistoryDedupContext = ctx || null;
}

function pushUniqueArticle(targetList, article, seenSet) {
    if (!article || !article.url) return false;
    var key = normalizeArticleUrlForDedup(article.url);
    if (!key) return false;
    if (!forceReprocessExisting && runHistoryDedupContext && runHistoryDedupContext.keys && runHistoryDedupContext.keys.has(key)) {
        if (runHistoryDedupContext.logged && !runHistoryDedupContext.logged[key]) {
            runHistoryDedupContext.logged[key] = true;
            var reason = (runHistoryDedupContext.byKey && runHistoryDedupContext.byKey[key]) || 'ACCETTATI/SCARTATI';
            var title = String((article && article.title) || '').trim();
            var url = String((article && article.url) || '').trim();
            var label = title ? (title + ' | ' + url) : url;
            logToConsole('[Raccolta][PRESENTE ' + reason + '] ' + label + ' -> salto link.', 'warn');
        }
        return false;
    }
    if (seenSet.has(key)) return false;
    seenSet.add(key);
    targetList.push(article);
    return true;
}

async function saveUrls() {
    if (!urlsLoaded) {
        logToConsole('Salvataggio bloccato: gli URL non sono stati caricati correttamente.', 'error');
        return;
    }
    
    logToConsole('Salvataggio lista URL...', 'info');
    try {
        var urlRes = await fetch('/api/urls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(urlList)
        });
        if (!urlRes.ok) throw new Error('Salvataggio URL fallito');
        logToConsole('Lista URL salvata con successo.', 'success');
        await saveFolderSettings();
    } catch (e) {
        logToConsole('Errore nel salvataggio: ' + e.message, 'error');
    }
}

// Polling for logs
let pollInterval;

function startServerLogPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(pollLogs, 1000);
}

async function pollLogs() {
    try {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        if (Array.isArray(logs) && logs.length > 0) {
            var logShowQuestions = !!(document.getElementById('log-show-questions') && document.getElementById('log-show-questions').checked);
            var logShowResponses = !!(document.getElementById('log-show-responses') && document.getElementById('log-show-responses').checked);
            logs.forEach(function (log) {
                if (log.kind === 'question' && !logShowQuestions) return;
                if (log.kind === 'response' && !logShowResponses) return;
                logToConsole(log.message, log.type || 'info');
            });
        }
    } catch (e) {
        console.error("Log polling error:", e);
    }
}

// Validità articoli (ore): 24 | 48 (default) | 72 | 168 (7 giorni) | 360 (15gg) | 480 (20gg) | 720 (30 giorni)
var validityHours = 48;
// Tempo di retroelaborazione (ore) per EMWA_Pesato: 24 | 48 | 72 | 168 (7gg) | 360 (15gg) | 480 (20gg) | 720 (30gg) — articoli più vecchi non considerati
var emwaLookbackHours = 168;
// Aggiornamento automatico dei JSON EMWA/Articoli_riassunto: 0=OFF, altrimenti 10/20/50/100 articoli validi
var jsonUpdateEvery = 0;

function isRecent(dateString) {
    if (!dateString) return false;
    var s = String(dateString).toLowerCase().trim();
    if (/^ieri$/.test(s)) return (24 <= validityHours);
    var rel = s.match(/(\d+)\s*(?:ora|ore|minuto|minuti|giorno|giorni|settimana|settimane)\s+fa/i);
    if (rel) {
        var n = parseInt(rel[1], 10);
        var u = (rel[0] || '').toLowerCase();
        var hoursAgo = u.indexOf('settiman') !== -1 ? n * 24 * 7 : (u.indexOf('giorn') !== -1 ? n * 24 : (u.indexOf('minut') !== -1 ? n / 60 : n));
        return hoursAgo <= validityHours;
    }
    // Normalizza "DD Month YYYY - HH:MM" (es. ANSA) in formato parsabile
    var toParse = String(dateString).trim().replace(/\s+-\s+(\d{1,2}:\d{2})/, ' $1');
    var date = new Date(toParse);
    if (isNaN(date.getTime())) return false;
    var now = new Date();
    var cutoff = new Date(now.getTime() - (validityHours * 60 * 60 * 1000));
    return date >= cutoff;
}

function initValiditySelector() {
    var opts = document.getElementById('validity-options');
    if (!opts) return;
    var btns = opts.querySelectorAll('.validity-btn');
    var h = validityHours;
    btns.forEach(function(btn) {
        if (parseInt(btn.dataset.hours, 10) === h) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    btns.forEach(function(btn) {
        btn.onclick = function() {
            validityHours = parseInt(btn.dataset.hours, 10);
            btns.forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            if (!isApplyingFolderSettings) saveFolderSettings().catch(function () {});
        };
    });
}

function parseBool(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
}

function setCheckboxValue(id, checked) {
    var cb = document.getElementById(id);
    if (!cb) return;
    cb.checked = !!checked;
}

function setActiveValidityHours(hours) {
    var h = parseInt(hours, 10);
    if ([24, 48, 72, 168, 360, 480, 720].indexOf(h) === -1) h = 48;
    validityHours = h;
    var opts = document.getElementById('validity-options');
    if (!opts) return;
    var btns = opts.querySelectorAll('.validity-btn');
    btns.forEach(function (btn) {
        btn.classList.toggle('active', parseInt(btn.dataset.hours, 10) === h);
    });
}

function setEmwaLookbackHours(hours) {
    var h = parseInt(hours, 10);
    if ([24, 48, 72, 168, 360, 480, 720].indexOf(h) === -1) h = 168;
    emwaLookbackHours = h;
    var opts = document.getElementById('emwa-lookback-options');
    if (!opts) return;
    var btns = opts.querySelectorAll('.validity-btn');
    btns.forEach(function (btn) {
        btn.classList.toggle('active', parseInt(btn.dataset.hours, 10) === h);
    });
}

function setJsonUpdateEvery(value) {
    var v = parseInt(value, 10);
    if ([0, 10, 20, 50, 100].indexOf(v) === -1) v = 0;
    jsonUpdateEvery = v;
    var opts = document.getElementById('json-update-options');
    if (!opts) return;
    var btns = opts.querySelectorAll('.validity-btn');
    btns.forEach(function (btn) {
        btn.classList.toggle('active', parseInt(btn.dataset.count, 10) === v);
    });
}

function initJsonUpdateSelector() {
    var opts = document.getElementById('json-update-options');
    if (!opts) return;
    var btns = opts.querySelectorAll('.validity-btn');
    var current = jsonUpdateEvery;
    btns.forEach(function (btn) {
        var v = parseInt(btn.dataset.count, 10);
        btn.classList.toggle('active', v === current);
    });
    btns.forEach(function (btn) {
        btn.onclick = function () {
            var v = parseInt(btn.dataset.count, 10);
            setJsonUpdateEvery(v);
            if (!isApplyingFolderSettings) saveFolderSettings().catch(function () {});
        };
    });
}

function initEmwaLookbackSelector() {
    var opts = document.getElementById('emwa-lookback-options');
    if (!opts) return;
    var btns = opts.querySelectorAll('.validity-btn');
    var h = emwaLookbackHours;
    btns.forEach(function (btn) {
        if (parseInt(btn.dataset.hours, 10) === h) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    btns.forEach(function (btn) {
        btn.onclick = function () {
            emwaLookbackHours = parseInt(btn.dataset.hours, 10);
            btns.forEach(function (b) { b.classList.remove('active'); });
            btn.classList.add('active');
            if (!isApplyingFolderSettings) saveFolderSettings().catch(function () {});
            refreshArticlesDateRangeLabel();
        };
    });
}

function setAnalyzeConcurrent(value) {
    var v = parseInt(value, 10);
    if (ALLOWED_CONCURRENT.indexOf(v) === -1) v = 1;
    var opts = document.getElementById('analyze-concurrent-options');
    if (!opts) return;
    var btns = opts.querySelectorAll('.validity-btn');
    btns.forEach(function (btn) {
        btn.classList.toggle('active', parseInt(btn.dataset.value, 10) === v);
    });
    updateActiveAgentsUI();
}

function getFolderSettingsPayload() {
    var debugOne = !!(document.getElementById('debug-one-article') && document.getElementById('debug-one-article').checked);
    var onlySearch = !!(document.getElementById('only-search-phase') && document.getElementById('only-search-phase').checked);
    var logQuestions = !!(document.getElementById('log-show-questions') && document.getElementById('log-show-questions').checked);
    var logResponses = !!(document.getElementById('log-show-responses') && document.getElementById('log-show-responses').checked);
    var useEmwaParams = !!(document.getElementById('use-emwa-params') && document.getElementById('use-emwa-params').checked);
    var forceDeepseekChat = !!(document.getElementById('force-deepseek-chat') && document.getElementById('force-deepseek-chat').checked);
    var autoSendEmail = !!(document.getElementById('auto-send-email') && document.getElementById('auto-send-email').checked);
    var telegramElabReport = !!(document.getElementById('telegram-elab-report') && document.getElementById('telegram-elab-report').checked);
    // Sincronizza il flag di forzatura rielaborazione con lo stato della checkbox, se presente
    var forceReElabCb = document.getElementById('force-reprocess-existing');
    if (forceReElabCb) {
        forceReprocessExisting = !!forceReElabCb.checked;
    }
    var activeByUrl = {};
    if (Array.isArray(urlList)) {
        urlList.forEach(function (item) {
            if (item && item.url != null) activeByUrl[String(item.url)] = item.active !== false;
        });
    }
    return {
        validity_hours: validityHours,
        emwa_lookback_hours: emwaLookbackHours,
        analyze_max_concurrent: getParallelAnalyzeLimit(),
        batch_wait_minutes: getBatchWaitMinutes(),
        email_progressivo: emailProgressivo,
        debug_one_article: debugOne,
        only_search_phase: onlySearch,
        log_show_questions: logQuestions,
        log_show_responses: logResponses,
        use_emwa_params: useEmwaParams,
        force_deepseek_chat: forceDeepseekChat,
        auto_send_email: autoSendEmail,
        telegram_elab_report_enabled: telegramElabReport,
        force_sintesi_each_valid: !!forceSintesiEachValid,
        force_reprocess_existing: !!forceReprocessExisting,
        json_update_every: jsonUpdateEvery,
        url_list_settings: { activeByUrl: activeByUrl }
    };
}

async function saveFolderSettings() {
    var payload = getFolderSettingsPayload();
    var res = await fetch('/api/folder-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    var data = await res.json();
    if (!res.ok || data.error) {
        throw new Error(data.error || 'Errore salvataggio impostazioni cartella');
    }
}

async function loadFolderSettings() {
    var res = await fetch('/api/folder-settings');
    var data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Errore caricamento impostazioni cartella');
    var s = (data && data.settings) ? data.settings : {};
    isApplyingFolderSettings = true;
    try {
        setActiveValidityHours(s.validity_hours);
        setEmwaLookbackHours(s.emwa_lookback_hours != null ? s.emwa_lookback_hours : 168);
        setJsonUpdateEvery(s.json_update_every != null ? s.json_update_every : 0);
        setAnalyzeConcurrent(s.analyze_max_concurrent);
        setBatchWaitMinutes(s.batch_wait_minutes != null ? s.batch_wait_minutes : 0);
        emailProgressivo = (typeof s.email_progressivo === 'number' && s.email_progressivo >= 0) ? s.email_progressivo : 0;
        setCheckboxValue('debug-one-article', parseBool(s.debug_one_article));
        setCheckboxValue('only-search-phase', parseBool(s.only_search_phase));
        setCheckboxValue('log-show-questions', parseBool(s.log_show_questions));
        setCheckboxValue('log-show-responses', parseBool(s.log_show_responses));
        setCheckboxValue('use-emwa-params', parseBool(s.use_emwa_params));
        setCheckboxValue('force-deepseek-chat', parseBool(s.force_deepseek_chat));
        setCheckboxValue('auto-send-email', parseBool(s.auto_send_email));
        setCheckboxValue('telegram-elab-report', parseBool(s.telegram_elab_report_enabled));
        setCheckboxValue('force-reprocess-existing', parseBool(s.force_reprocess_existing));
        forceSintesiEachValid = parseBool(s.force_sintesi_each_valid);
        forceReprocessExisting = parseBool(s.force_reprocess_existing);
        // Lista URL: sempre da Json/urls.json (unica). In cartella solo i settaggi (quali URL sono attivi).
        var urlRes = await fetch('/api/urls');
        urlList = await urlRes.json();
        if (!Array.isArray(urlList)) urlList = [];
        urlList.forEach(function (item, idx) {
            if (item && typeof item.pageUpTo !== 'number') item.pageUpTo = 0;
            if (item && item.type === 'telegram') item.pageUpTo = 0;
            if (item) item.type = detectUrlType(item.url || '') || 'blog';
        });
        var activeByUrl = (s.url_list_settings && s.url_list_settings.activeByUrl && typeof s.url_list_settings.activeByUrl === 'object') ? s.url_list_settings.activeByUrl : null;
        if (activeByUrl) {
            urlList.forEach(function (item) {
                if (item && item.url != null) {
                    var key = String(item.url);
                    if (Object.prototype.hasOwnProperty.call(activeByUrl, key)) item.active = activeByUrl[key] !== false;
                }
            });
        }
        urlsLoaded = true;
        renderList();
    } finally {
        isApplyingFolderSettings = false;
    }
}

var elaborationInProgress = false;
var abortElaboration = false;
var processAbortController = null;
var analyzeAbortController = null;
var activeAbortControllers = new Set();
const ELABORATION_IN_PROGRESS_KEY = 'vision-elaboration-in-progress';

function registerAbortController(ctrl) {
    if (ctrl) activeAbortControllers.add(ctrl);
    return ctrl;
}

function releaseAbortController(ctrl) {
    if (ctrl) activeAbortControllers.delete(ctrl);
}

function abortAllActiveControllers() {
    activeAbortControllers.forEach(function (ctrl) {
        try { ctrl.abort(); } catch (_) {}
    });
    activeAbortControllers.clear();
}

function setParamsPanelEnabled(enabled) {
    // Blocca/sblocca tutti e 3 i pannelli della sidebar (URL, Parametri, Cartelle)
    var allSections = document.querySelectorAll('[data-panel-section="params"], [data-panel-section="url"], [data-panel-section="folders"]');
    allSections.forEach(function (el) { el.classList.toggle('sidebar-panel-locked', !enabled); });

    // Mantieni lo stile specifico per il blocco dei controlli di Parametri
    var sections = document.querySelectorAll('[data-panel-section="params"]');
    sections.forEach(function (el) { el.classList.toggle('params-locked', !enabled); });
    var btns = document.querySelectorAll('#validity-options button, #analyze-concurrent-options button');
    btns.forEach(function (btn) { btn.disabled = !enabled; });
    var waitRange = document.getElementById('batch-wait-range');
    if (waitRange) waitRange.disabled = !enabled;
    var ids = ['debug-one-article', 'only-search-phase', 'log-show-questions', 'log-show-responses', 'use-emwa-params', 'force-deepseek-chat', 'auto-send-email', 'telegram-elab-report', 'force-reprocess-existing'];
    ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.disabled = !enabled;
    });
    // Blocca tutte le tab della sidebar (Gestione URL, Parametri, Cartelle)
    var tabs = document.querySelectorAll('.sidebar-tab');
    tabs.forEach(function (t) { t.classList.toggle('sidebar-tab-locked', !enabled); });
}

function setStartStopButton(running) {
    var btn = document.getElementById('start-stop-btn');
    var clearBtn = document.getElementById('clear-json-btn');
    if (!btn) return;
    elaborationInProgress = running;
    setParamsPanelEnabled(!running);
    try {
        localStorage.setItem(ELABORATION_IN_PROGRESS_KEY, running ? '1' : '0');
    } catch (e) {}
    if (running) {
        btn.textContent = 'STOP';
        btn.classList.add('running');
        btn.onclick = stopElaboration;
        if (clearBtn) clearBtn.disabled = true;
    } else {
        btn.textContent = 'START';
        btn.classList.remove('running');
        btn.onclick = handleStartStop;
        abortElaboration = false;
        if (clearBtn) clearBtn.disabled = false;
    }
}

function handleStartStop() {
    if (elaborationInProgress) return;
    processUrls();
}

async function clearJsonFiles() {
    if (elaborationInProgress) {
        logToConsole('CLEAR non disponibile durante l\'elaborazione in corso.', 'warn');
        return;
    }
    if (!window.confirm('Azzerare tutti i file JSON della cartella attiva?\n\n(articles, articolielaborati, note, sintesi, Questions, ecc. — l\'operazione non si può annullare)')) {
        return;
    }
    try {
        var res = await fetch('/api/clear-json', { method: 'POST' });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data || data.success !== true) {
            throw new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
        }
        currentArticles = [];
        logToConsole('CLEAR completato: JSON della cartella attiva azzerati.', 'success');
        await refreshArticlesDateRangeLabel();
        await updateArticolielaboratiCountDisplay();
        await refreshAcceptedList();
        await refreshNationSintesi();
        await refreshNationAggregate();
        await refreshNationSintesiAlternativa();
        await refreshNationEmwaIa();
        await refreshNationNote();
        await refreshNationSintesiV4();
        await refreshNationSintesiV5();
        await refreshNationSintesiElabIa();
        await refreshSintesiVRed();
        if (map && typeof map.removeMarkers === 'function' && typeof map.addMarkers === 'function') {
            map.removeMarkers();
            map.addMarkers(getMarkersFromSintesi());
            applyRegionColorsFromSintesi();
        }
        if (map && typeof map.updateSize === 'function') map.updateSize();
    } catch (e) {
        logToConsole('Errore CLEAR: ' + e.message, 'error');
    }
}

async function clearScartatiYouTube() {
    var btn = document.getElementById('clear-scartati-youtube-btn');
    if (btn) btn.disabled = true;
    try {
        var res = await fetch('/api/clear-scartati-youtube', { method: 'POST' });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.success) {
            throw new Error((data && data.error) || ('HTTP ' + res.status));
        }
        var removed = data.removed != null ? data.removed : 0;
        var remaining = data.remaining != null ? data.remaining : 0;
        logToConsole('Rimossi da Scartati ' + removed + ' video YouTube (restano ' + remaining + ' entry). Alla prossima run verranno rielaborati.', 'success');
        await refreshAcceptedList();
    } catch (e) {
        logToConsole('Errore rimozione YouTube da Scartati: ' + e.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function openVisionEmail(options) {
    var opts = (options && typeof options === 'object') ? options : {};
    var silent = opts.silent === true;
    var btn = document.getElementById('vision-email-btn');
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try {
        var res = await fetch('/api/send-email-riassunto', { method: 'POST' });
        var data = await res.json().catch(function () { return {}; });
        if (res.ok && data && data.skipped === true) {
            var skipMsg = data && data.message ? data.message : 'Email non inviata.';
            logToConsole(skipMsg, 'info');
            return { ok: false, skipped: true, data: data };
        }
        if (res.ok && data && data.ok) {
            if (typeof data.email_progressivo === 'number' && data.email_progressivo >= 0) {
                emailProgressivo = data.email_progressivo;
            }
            logToConsole(silent ? 'Invio report automatico completato.' : 'Report inviato con successo.', 'success');
            return { ok: true, data: data };
        } else {
            var errMsg = (data && data.error ? data.error : res.status);
            logToConsole("Errore durante l'invio del report: " + errMsg, 'error');
            return { ok: false, error: errMsg };
        }
    } catch (e) {
        logToConsole("Errore durante l'invio del report: " + e.message, 'error');
        return { ok: false, error: e.message };
    } finally {
        if (btn) btn.disabled = false;
    }
}

function stopElaboration() {
    // Se c'è un timer batch attivo, questo STOP serve solo a cancellare il riavvio automatico
    if (batchAutoRestartTimer) {
        clearTimeout(batchAutoRestartTimer);
        batchAutoRestartTimer = null;
        updateAppTitleBatchTimer(null);
        logToConsole('Riavvio automatico batch annullato. Torno in standby.', 'warn');
        setStartStopButton(false);
        return; // Non esegue l'abort vero e proprio perché non c'è nulla in corso, solo attesa
    }

    abortElaboration = true;
    var stoppedNow = false;
    if (processAbortController) {
        try {
            processAbortController.abort();
            stoppedNow = true;
        } catch (_) {}
    }
    if (analyzeAbortController) {
        try {
            analyzeAbortController.abort();
            stoppedNow = true;
        } catch (_) {}
    }
    if (activeAbortControllers.size > 0) {
        abortAllActiveControllers();
        stoppedNow = true;
    }
    if (stoppedNow) logToConsole('STOP richiesto: blocco immediato delle richieste in corso...', 'warn');
    else logToConsole('STOP richiesto: nessuna richiesta attiva, arresto al prossimo controllo.', 'warn');
    resetActiveAgents();
    fetch('/api/abort-elaboration', { method: 'POST', keepalive: true }).catch(function () {});
}

function scheduleNextBatchIfNeeded() {
    var waitMin = getBatchWaitMinutes();
    if (!waitMin || waitMin <= 0) {
        updateAppTitleBatchTimer(null);
        return false;
    }
    if (batchAutoRestartTimer) clearTimeout(batchAutoRestartTimer);
    var targetTime = Date.now() + (waitMin * 60 * 1000);
    updateAppTitleBatchTimer(targetTime);
    setStartStopButton(true); // Imposta visivamente il pulsante su STOP (per poter annullare l'attesa)
    
    batchAutoRestartTimer = setTimeout(function () {
        batchAutoRestartTimer = null;
        updateAppTitleBatchTimer(null);
        setStartStopButton(false);
        processUrls();
    }, waitMin * 60 * 1000);
    logToConsole('Prossimo batch pianificato tra ' + formatBatchWaitLabel(waitMin) + '.', 'info');
    return true;
}

async function processUrls() {
    const resultsDiv = document.getElementById('results-content');
    const consoleOutput = document.getElementById('console-output');
    
    if (elaborationInProgress) return;
    if (batchAutoRestartTimer) {
        clearTimeout(batchAutoRestartTimer);
        batchAutoRestartTimer = null;
        updateAppTitleBatchTimer(null);
    }
    setStartStopButton(true);
    abortElaboration = false;

    // Clear previous logs
    if (consoleOutput) consoleOutput.innerHTML = '';
    
    logToConsole('--- INIZIO ELABORAZIONE ---', 'info');
    if (resultsDiv) resultsDiv.textContent = 'Elaborazione in corso...';
    
    // Assicura polling log backend attivo durante tutta la sessione UI
    startServerLogPolling();
    
    // First ensure latest list is saved/used
    await saveUrls(); 

    try {
        logToConsole('Richiesta inviata al server. Scaricamento HTML...', 'warn');

        var logShowQuestions = !!(document.getElementById('log-show-questions') && document.getElementById('log-show-questions').checked);
        var expandedUrls = expandUrlListForPages(urlList);
        var urlsTotal = Array.isArray(expandedUrls) ? expandedUrls.length : 0;
        var urlsExamined = 0;
        setProgressPhase('urls', { urlsTotal: urlsTotal, urlsExamined: 0 });
        updateProgressBar(urlsTotal, 0);
        processAbortController = registerAbortController(new AbortController());
        const res = await fetch('/api/process', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ log_questions: !!logShowQuestions, urls: expandedUrls }),
            signal: processAbortController.signal
        });
        const data = await res.json();
        if (data.aborted) {
            logToConsole('Elaborazione interrotta dall\'utente (scraping).', 'warn');
        }
        
        // Final poll (flush immediato dei log accumulati)
        await pollLogs();
        
        logToConsole('HTML Ricevuto. Inizio analisi Frontend...', 'info');
        
        const validArticles = [];
        const seenArticleKeys = new Set();
        setRunHistoryDedupContext({ keys: new Set(), byKey: {}, logged: {} });
        try {
            var accRes = await fetch('/api/accettati');
            var scaRes = await fetch('/api/scartati');
            var accData = accRes.ok ? await accRes.json() : [];
            var scaData = scaRes.ok ? await scaRes.json() : [];
            var hist = runHistoryDedupContext;
            var addHist = function (urlLike, reason) {
                var k = normalizeArticleUrlForDedup(urlLike);
                if (!k || !hist || !hist.keys) return;
                hist.keys.add(k);
                if (!hist.byKey[k]) hist.byKey[k] = reason;
            };
            if (Array.isArray(accData)) {
                accData.forEach(function (a) {
                    addHist((a && (a.link || a.url)) || '', 'ACCETTATI');
                });
            }
            if (Array.isArray(scaData)) {
                scaData.forEach(function (s) {
                    addHist((s && (s.url || s.link)) || '', 'SCARTATI');
                });
            }
            var histCount = hist && hist.keys ? hist.keys.size : 0;
            if (histCount > 0) {
                logToConsole('[Raccolta] Dedup su storico attivo: ' + histCount + ' URL da Accettati/Scartati.', 'info');
            }
        } catch (eHist) {
            logToConsole('[Raccolta] Dedup su Accettati/Scartati non disponibile: ' + eHist.message, 'warn');
        }
        var logShowQuestionsProcess = !!(document.getElementById('log-show-questions') && document.getElementById('log-show-questions').checked);
        
        if (data.details) {
            data.details.forEach(item => {
                urlsExamined++;
                setProgressPhase('urls', { urlsTotal: urlsTotal, urlsExamined: urlsExamined });
                updateProgressBar(urlsTotal, urlsExamined);
                if (item.type === 'telegram_posts' && item.original_type === 'telegram_ai' && Array.isArray(item.tg_posts)) {
                    logToConsole('[Telegram IA] Post ricevuti: ' + item.tg_posts.length, item.tg_posts.length > 0 ? 'success' : 'warn');
                    if (logShowQuestionsProcess && item.tg_prompt_preview) {
                        var prev = String(item.tg_prompt_preview || '');
                        // Mostra anteprima della richiesta IA
                        var headerPreview = prev.length > 600 ? prev.substring(0, 600) + '...' : prev;
                        logToConsole('[Telegram IA invio] ' + headerPreview, 'info');
                        // Prova a estrarre solo la parte di testo "spezzato" (dopo la prima doppia newline)
                        var partsPrompt = prev.split(/\n\n/);
                        if (partsPrompt.length >= 2) {
                            var cleanPart = partsPrompt.slice(1).join('\n\n');
                            var chunks = cleanPart.split(/--- FINE POST---\s*/);
                            chunks.forEach(function (chunk, cIdx) {
                                var chunkText = String(chunk || '').trim();
                                if (!chunkText) return;
                                var snippet = chunkText.length > 300 ? (chunkText.substring(0, 300) + '…') : chunkText;
                                logToConsole('[Telegram HTML spezzato #' + (cIdx + 1) + '] ' + snippet, 'info');
                            });
                        }
                    }
                    if (item.tg_posts.length === 0) {
                        logToConsole('[Telegram IA] Nessun post estratto. Verifica prompt scraping_Telegram o canale non accessibile.', 'warn');
                    }
                    let foundForThisUrl = 0;
                    const seenYoutubeFromTelegram = new Set();
                    function stripLinks(s) {
                        if (!s || typeof s !== 'string') return '';
                        return s.replace(/https?:\/\/[^\s]*/g, '').replace(/www\.[^\s]*/g, '').replace(/(?:t\.me|telegram\.me)\/[^\s]*/g, '').replace(/\s+/g, ' ').trim();
                    }
                    item.tg_posts.forEach(function (p, idx) {
                        var rawFull = String((p && p.testo) || '').trim();
                        var testo = stripLinks(rawFull);
                        if (!testo) return;
                        var dateStr = String((p && p.Data) || '').trim();
                        if (!dateStr) dateStr = new Date().toISOString().substring(0, 10);

                        // Estrai eventuali link secondari dal testo completo del post
                        if (rawFull) {
                            try {
                                var linkMatches = rawFull.match(/https?:\/\/[^\s]+/g) || [];
                                linkMatches.forEach(function (lnk) {
                                    var clean = String(lnk || '').trim().replace(/[,.;!?]+$/, '');
                                    if (!clean) return;
                                    // Link Telegram: ignorati (non sono link secondari da analizzare come articoli esterni)
                                    if (/^https?:\/\/(?:t\.me|telegram\.me)\//i.test(clean)) return;
                                    // Link YouTube: non vanno in link_secondari, ma trattati separatamente come possibili video
                                    if (/youtube\.com|youtu\.be/i.test(clean)) return;
                                    addSecondaryLink(clean, dateStr);
                                });
                            } catch (_) {}
                        }

                        // Costruisci titolo e URL sintetico per l'articolo Telegram (testo del post)
                        var title = testo.length > 60 ? testo.substring(0, 60) + '...' : testo;
                        var linkvideo = String((p && p.linkvideo) || '').trim();
                        var syntheticUrl = buildTelegramStableArticleUrl(item.url, '', testo, dateStr, idx + 1, linkvideo);
                        var added = pushUniqueArticle(validArticles, {
                            url: syntheticUrl,
                            date: dateStr,
                            title: title,
                            source: item.url,
                            type: 'telegram',
                            listType: item.type,
                            text: testo
                        }, seenArticleKeys);
                        if (added) {
                            foundForThisUrl++;
                            var snippetPost = testo.length > 260 ? (testo.substring(0, 260) + '…') : testo;
                            logToConsole('[Telegram Post considerato #' + (idx + 1) + '] ' + snippetPost, 'info');
                        }

                        // Raccogli eventuali link YouTube diretti presenti nel testo o nel campo linkvideo
                        var youtubeIds = [];
                        if (rawFull) {
                            try {
                                var ytMatches = rawFull.match(/https?:\/\/[^\s]+/g) || [];
                                ytMatches.forEach(function (lnk) {
                                    var clean = String(lnk || '').trim().replace(/[,.;!?]+$/, '');
                                    if (!clean) return;
                                    var vid = getYoutubeVideoIdFromUrl(clean);
                                    if (!vid) return;
                                    if (seenYoutubeFromTelegram.has(vid)) return;
                                    seenYoutubeFromTelegram.add(vid);
                                    youtubeIds.push(vid);
                                });
                            } catch (_) {}
                        }
                        if (linkvideo) {
                            var vidFromField = getYoutubeVideoIdFromUrl(linkvideo);
                            if (vidFromField && !seenYoutubeFromTelegram.has(vidFromField)) {
                                seenYoutubeFromTelegram.add(vidFromField);
                                youtubeIds.push(vidFromField);
                            }
                        }

                        // Per ogni video YouTube trovato, crea un articolo di tipo 'youtube' (se non già presente in run/historical)
                        youtubeIds.forEach(function (vid) {
                            var ytUrl = 'https://www.youtube.com/watch?v=' + vid;
                            var ytTitleBase = testo.length > 80 ? testo.substring(0, 80) + '...' : testo;
                            var ytTitle = ytTitleBase ? ('[Telegram] ' + ytTitleBase) : ('YouTube video ' + vid);
                            var addedYt = pushUniqueArticle(validArticles, {
                                url: ytUrl,
                                date: dateStr,
                                title: ytTitle.length > 120 ? ytTitle.substring(0, 120) + '...' : ytTitle,
                                source: item.url,
                                type: 'youtube',
                                listType: 'telegram_video',
                                youtube_video_id: vid
                            }, seenArticleKeys);
                            if (addedYt) {
                                logToConsole('[Telegram → YouTube] Video accodato per trascrizione: ' + vid, 'info');
                            } else {
                                logToConsole('[Telegram → YouTube][PRESENTE] ' + ytUrl + ' -> salto video.', 'warn');
                            }
                        });
                    });
                    logToConsole('Finito ' + item.url + ': Trovati ' + foundForThisUrl + ' post da IA.', foundForThisUrl > 0 ? 'success' : 'warn');
                }
                else if (item.type === 'youtube_links' && Array.isArray(item.yt_links)) {
                    logToConsole('[YouTube IA] Link video ricevuti: ' + item.yt_links.length, item.yt_links.length > 0 ? 'success' : 'warn');
                    if (logShowQuestionsProcess && item.yt_prompt_preview) {
                        var prevYt = String(item.yt_prompt_preview || '');
                        if (prevYt.length > 2000) prevYt = prevYt.substring(0, 2000) + '...';
                        logToConsole('[YouTube IA invio] ' + prevYt, 'info');
                    }
                    if (item.yt_links.length === 0) {
                        logToConsole('[YouTube IA] Nessun link video estratto. Verifica prompt scraping_Youtube o URL canale.', 'warn');
                    }
                    let foundForThisUrl = 0;
                    const seenVideoIds = new Set();
                    item.yt_links.forEach(function (v) {
                        var link = String((v && (v.linkvideo || v.link || v.url)) || '').trim();
                        var vid = getYoutubeVideoIdFromUrl(link);
                        if (!vid || seenVideoIds.has(vid)) return;
                        seenVideoIds.add(vid);
                        var t = String((v && (v.title || v.titolo)) || '').trim();
                        if (!t) t = 'YouTube video ' + vid;
                        var added = pushUniqueArticle(validArticles, {
                            url: 'https://www.youtube.com/watch?v=' + vid,
                            date: new Date().toISOString().substring(0, 10),
                            title: t.length > 120 ? t.substring(0, 120) + '...' : t,
                            source: item.url,
                            type: 'youtube',
                            listType: item.type,
                            youtube_video_id: vid
                        }, seenArticleKeys);
                        if (added) {
                            foundForThisUrl++;
                            logToConsole('[YouTube IA] Video accodato per trascrizione: ' + vid, 'info');
                        }
                    });
                    logToConsole('Finito ' + item.url + ': Trovati ' + foundForThisUrl + ' video da IA.', foundForThisUrl > 0 ? 'success' : 'warn');
                }
                else if (item.type === 'raw_xml' && item.html) {
                    logToConsole('Analisi RSS per: ' + item.url, 'info');
                    var foundForThisUrl = 0;
                    var seenUrlsRss = new Set();
                    try {
                        var parser = new DOMParser();
                        var docXml = parser.parseFromString(item.html, 'text/xml');
                        var channel = docXml.querySelector('channel');
                        if (!channel) channel = docXml.querySelector('feed');
                        if (channel) {
                            var items = channel.querySelectorAll('item');
                            if (!items.length) items = channel.querySelectorAll('entry');
                            for (var r = 0; r < items.length; r++) {
                                var it = items[r];
                                var pubEl = it.querySelector('pubDate, published, updated');
                                var dateStr = pubEl ? (pubEl.getAttribute('datetime') || (pubEl.textContent || '').trim()) : '';
                                var linkEl = it.querySelector('link');
                                var link = '';
                                if (linkEl) {
                                    link = (linkEl.getAttribute('href') || linkEl.getAttribute('url') || (linkEl.textContent || '').trim());
                                }
                                if (!link) continue;
                                try {
                                    var fullUrl = new URL(String(link).trim().replace(/[:.,;!?#]+(\/?)$/, '$1'), item.url).href;
                                    if (!fullUrl || fullUrl === item.url || seenUrlsRss.has(fullUrl)) continue;
                                    seenUrlsRss.add(fullUrl);
                                } catch (_) { continue; }
                                var titleEl = it.querySelector('title');
                                var title = titleEl ? (titleEl.textContent || '').trim() : 'No Title';
                                if (!title) title = 'No Title';
                                var dateNorm = normalizeRssDateString(dateStr);
                                var recent = isRecent(dateNorm);
                                logToConsole('[RSS] "' + title.substring(0, 40) + '" | ' + dateNorm + ' | -> ' + (recent ? 'KEEP' : 'SKIP'), recent ? 'success' : 'info');
                                if (recent) {
                                    pushUniqueArticle(validArticles, {
                                        url: fullUrl,
                                        date: dateNorm,
                                        title: title,
                                        source: item.url,
                                        type: 'blog',
                                        listType: 'rss'
                                    }, seenArticleKeys);
                                    foundForThisUrl++;
                                }
                            }
                        }
                    } catch (eRss) {
                        logToConsole('[RSS] Errore parsing XML: ' + (eRss && eRss.message ? eRss.message : 'unknown'), 'warn');
                    }
                    logToConsole('Finito ' + item.url + ': Trovati ' + foundForThisUrl + ' elementi recenti.', foundForThisUrl > 0 ? 'success' : 'info');
                }
                else if (item.type === 'raw_html' && (item.html || (item.original_type === 'telegram' && item.single_text))) {
                    logToConsole(`Analisi DOM per: ${item.url}`, 'info');
                    
                    let doc = null;
                    if (item.html) {
                        const parser = new DOMParser();
                        doc = parser.parseFromString(item.html, 'text/html');
                    }
                    
                    let foundForThisUrl = 0;
                    const seenUrls = new Set();

                    // --- YOUTUBE: pagina /videos del canale -> lista link video ---
                    if (item.original_type === 'youtube') {
                        logToConsole('[YouTube] Scansione elenco video del canale...', 'info');
                        var seenVideoIds = new Set();
                        var dateYt = new Date().toISOString().substring(0, 10);
                        var links = Array.from(doc.querySelectorAll('a[href]'));
                        links.forEach(function (el) {
                            var href = el.getAttribute('href');
                            if (!href) return;
                            var abs = '';
                            try { abs = new URL(href, item.url).href; } catch (_) { return; }
                            var vid = getYoutubeVideoIdFromUrl(abs);
                            if (!vid || seenVideoIds.has(vid)) return;
                            seenVideoIds.add(vid);
                            var t = (el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim();
                            
                            // SEGNAPOSTO: se il titolo è assente o generico (es. "YouTube video..."),
                            // forziamo un titolo speciale che il server riconoscerà per saltare il controllo pertinenza
                            // e procedere direttamente alla trascrizione.
                            var isGenericTitle = !t || /YouTube video [a-zA-Z0-9_-]{11}/.test(t);
                            if (isGenericTitle) {
                                t = 'FORCE_TRANSCRIPT_CHECK: ' + vid;
                            }

                            pushUniqueArticle(validArticles, {
                                url: 'https://www.youtube.com/watch?v=' + vid,
                                date: dateYt,
                                title: t.length > 120 ? t.substring(0, 120) + '...' : t,
                                source: item.url,
                                type: 'youtube',
                                listType: item.type,
                                youtube_video_id: vid
                            }, seenArticleKeys);
                            foundForThisUrl++;
                        });
                        // Fallback regex su JSON inline se i link DOM non bastano
                        if (foundForThisUrl === 0) {
                            var htmlRaw = String(item.html || '');
                            var re = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
                            var m;
                            while ((m = re.exec(htmlRaw)) !== null) {
                                var vid2 = m[1];
                                if (!vid2 || seenVideoIds.has(vid2)) continue;
                                seenVideoIds.add(vid2);
                                
                                // Anche qui, titolo forzato se mancante
                                var t2 = 'FORCE_TRANSCRIPT_CHECK: ' + vid2;
                                
                                pushUniqueArticle(validArticles, {
                                    url: 'https://www.youtube.com/watch?v=' + vid2,
                                    date: dateYt,
                                    title: t2,
                                    source: item.url,
                                    type: 'youtube',
                                    listType: item.type,
                                    youtube_video_id: vid2
                                }, seenArticleKeys);
                                foundForThisUrl++;
                            }
                        }
                        logToConsole('[YouTube] Video trovati: ' + foundForThisUrl, foundForThisUrl > 0 ? 'success' : 'warn');
                    }
                    // --- TELEGRAM: testo unico da separare in post (se backend invia single_text) ---
                    else if (item.original_type === 'telegram' && item.single_text) {
                        var sep = typeof item.post_delimiter === 'string' && item.post_delimiter.length > 0 ? item.post_delimiter : 'VIEW IN TELEGRAM';
                        var sepRegex = new RegExp('(' + sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|\\[\\.\\.\\.\\])');
                        var parts = String(item.single_text).split(sepRegex).map(function (p) { return p.trim(); }).filter(function (p) {
                            if (p.length < 3) return false;
                            if (p === sep || p === '[...]') return false;
                            if (/please open telegram to view this post/i.test(p)) return false;
                            return true;
                        });
                        var numPost = parts.length;
                        logToConsole('Post ricavati: ' + numPost, 'success');
                        var autoDate = new Date().toISOString().substring(0, 10);
                        parts.forEach(function (testoPuro, idx) {
                            var title = testoPuro.length > 50 ? testoPuro.substring(0, 50) + '...' : testoPuro;
                            var syntheticUrlSingle = buildTelegramStableArticleUrl(item.url, '', testoPuro, autoDate, idx + 1, '');
                            pushUniqueArticle(validArticles, {
                                url: syntheticUrlSingle,
                                date: autoDate,
                                title: title,
                                source: item.url,
                                type: 'telegram',
                                listType: item.type,
                                html: '<body><div>' + String(testoPuro).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div></body>'
                            }, seenArticleKeys);
                            foundForThisUrl++;
                        });
                    }
                    // --- TELEGRAM: parsing DOM (messaggi dalla pagina HTML) ---
                    else if (item.original_type === 'telegram') {
                        logToConsole(`[Telegram] Scansione messaggi (ignoro link e immagini, prendo il testo se c'è)...`, 'info');
                        const messages = doc.querySelectorAll('.tgme_widget_message_wrap');
                        
                        messages.forEach(msg => {
                            const dateEl = msg.querySelector('.tgme_widget_message_date time');
                            if (!dateEl) return;
                            
                            const dateStr = dateEl.getAttribute('datetime') || dateEl.textContent;
                            const linkEl = msg.querySelector('.tgme_widget_message_date');
                            let postUrl = linkEl ? linkEl.getAttribute('href') : item.url;
                            
                            // Clean Telegram URL
                            if (postUrl) {
                                postUrl = postUrl.trim().replace(/[:.,;!?#]+(\/?)$/, '$1');
                            }
                            
                            const textEl = msg.querySelector('.tgme_widget_message_text');
                            // Testo puro (ignora link e immagini): clona, rimuovi a e img, prendi solo testo
                            let testoPuro = '';
                            if (textEl) {
                                const clone = textEl.cloneNode(true);
                                clone.querySelectorAll('a, img, [data-href]').forEach(function(n) { n.remove(); });
                                testoPuro = (clone.textContent || '').trim();
                            }
                            // Prendi solo messaggi con testo; ignora messaggi solo link/immagini
                            if (testoPuro.length < 3) {
                                return;
                            }
                            const title = testoPuro.length > 50 ? testoPuro.substring(0, 50) + '...' : testoPuro;

                            if (dateStr) {
                                const recent = isRecent(dateStr);
                                const status = recent ? "KEEP" : "SKIP";
                                logToConsole(`[Telegram] "${title}" | ${dateStr} | -> ${status}`, recent ? 'success' : 'info');
                                
                                if (recent) {
                                    var telegramPostUrl = buildTelegramStableArticleUrl(item.url, postUrl, testoPuro, dateStr, foundForThisUrl + 1, '');
                                    pushUniqueArticle(validArticles, {
                                        url: telegramPostUrl,
                                        date: dateStr,
                                        title: title,
                                        source: item.url,
                                        type: 'telegram',
                                        listType: item.type,
                                        html: '<body><div>' + String(testoPuro).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div></body>'
                                    }, seenArticleKeys);
                                    foundForThisUrl++;
                                }
                            }
                        });

                    }
                    // --- GENERIC BLOG / DEFAULT LOGIC ---
                    else {
                        logToConsole(`[Blog/Generic] Scansione link articoli (solo area contenuto principale)...`, 'info');
                        // Solo area contenuto principale: ignora menu, sidebar ("Ci sono piaciuti", ecc.), footer
                        const mainContentSelectors = [
                            '.list-item.grid-list',
                            '.post-list.ts-grid-box',
                            '.td_block_wrap.tdb_loop.tdb-category-loop-posts',
                            '.td_block_wrap.tdb_loop',
                            '.tdb-category-loop-posts',
                            '[data-td-block-uid="tdi_59"]',
                            '.vc_column.tdi_72.wpb_column.vc_column_container.tdc-column.td-pb-span9',
                            '.articles-list.wide',
                            '.articles-list',
                            '.blog56-wrapper.widget56[data-type="post-list"]',
                            '.blog56-wrapper.widget56',
                            '.blog56-wrapper',
                            '.widget56[data-type="post-list"]',
                            '[data-type="post-list"]',
                            'main', '[role="main"]', '#content', '.content', '.site-content',
                            '.main-content', '#main', '.content-area', '.posts', '.blog',
                            '.entries', '.post-list', '.archive', '.gh-main', '.post-feed'
                        ];
                        let articleRoot = null;
                        for (const sel of mainContentSelectors) {
                            try {
                                const el = doc.querySelector(sel);
                                if (el && el.querySelectorAll('a').length > 0) {
                                    articleRoot = el;
                                    break;
                                }
                            } catch (_) {}
                        }
                        const excludedZoneSelectors = 'nav, [role="navigation"], aside, .sidebar, #sidebar, footer, .footer, .menu, .navigation';
                        const categoryTagSelectors = '.cat-links, .entry-categories, .posted-in, .tags-links, .article-categories, .post-categories, .term-list';
                        const isInExcludedZoneByClass = (el) => {
                            const excludedClassRe = /sidebar|side-bar|side_bar|author|autore|writer|byline|scrittore|contributor/;
                            let p = el.parentElement;
                            while (p) {
                                const c = (p.getAttribute('class') || '').toLowerCase();
                                if (excludedClassRe.test(c)) return true;
                                p = p.parentElement;
                            }
                            return false;
                        };
                        const isExcluded = (linkEl) => {
                            try {
                                if (linkEl.closest(excludedZoneSelectors)) return true;
                                if (isInExcludedZoneByClass(linkEl)) return true;
                                // Categorie e tag: link a pagine archivio, non articoli
                                if (linkEl.closest(categoryTagSelectors) || linkEl.getAttribute('rel') === 'tag') return true;
                                // Site header (menu): escludi; header dentro card articolo no
                                const inHeader = linkEl.closest('header');
                                if (inHeader && !inHeader.closest('article, .td_module_wrap, .tdb_loop_item, .blog56__item, .post-item, .entry-item, li, .post, .card, .item')) return true;
                                const widget = linkEl.closest('.widget');
                                if (widget && (widget.closest('aside') || widget.closest('.sidebar'))) return true;
                                // Link agli autori: escludi (byline, rel="author", contenitori autore)
                                if (linkEl.getAttribute('rel') === 'author') return true;
                                if (linkEl.closest('.author, .byline, .post-author, .entry-author, .meta-author, .written-by, .contributor')) return true;
                                return false;
                            } catch (_) { return false; }
                        };
                        const isAuthorUrl = (urlStr) => {
                            try {
                                const u = new URL(urlStr, item.url);
                                const path = (u.pathname || '').toLowerCase();
                                const search = (u.search || '').toLowerCase();
                                if (/\/author\/|\/autore\/|\/writers?\/|\/user\/|\/profile\/|\/contributor\//.test(path)) return true;
                                if (/\?author=|\&author=/.test(search)) return true;
                                return false;
                            } catch (_) { return false; }
                        };
                        const isTagOrCategoryArchiveUrl = (urlStr) => {
                            try {
                                const u = new URL(urlStr, item.url);
                                const path = (u.pathname || '').toLowerCase();
                                if (/\/tag\/[^/]+\/?$/.test(path) || /\/category\/[^/]+\/?$/.test(path)) return true;
                                return false;
                            } catch (_) { return false; }
                        };
                        const looksLikeRealDate = (v) => {
                            if (!v) return false;
                            var s = String(v).toLowerCase().trim().replace(/\s+/g, ' ');
                            if (!s) return false;
                            if (/^(esteri|politica|economia|attualita|attualità|societa|società|salute|sport|lavoro|turismo|mercurio|news)$/.test(s)) return false;
                            if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
                            if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return true;
                            if (/^\d+\s*(ora|ore|minuto|minuti|giorno|giorni|settimana|settimane)\s+fa$/.test(s)) return true;
                            if (/^ieri$/.test(s)) return true;
                            if (/\b(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(s)) return true;
                            return false;
                        };
                        const normalizeDateStr = (v) => {
                            if (!v) return v;
                            var out = String(v).toLowerCase().trim();
                            // Rimuove prefissi del giorno (es. "martedì, 24 Febbraio 2026")
                            out = out.replace(/^(lunedì|lunedi|martedì|martedi|mercoledì|mercoledi|giovedì|giovedi|venerdì|venerdi|sabato|domenica),?\s+/i, '');
                            const partialMatch = out.match(/^(\d{1,2})[-/](\d{1,2})$/);
                            if (partialMatch) {
                                const currentYear = new Date().getFullYear();
                                out = `${currentYear}-${partialMatch[1]}-${partialMatch[2]}`;
                            }
                            const monthMap = {
                                'gennaio': 'January', 'febbraio': 'February', 'marzo': 'March', 'aprile': 'April',
                                'maggio': 'May', 'giugno': 'June', 'luglio': 'July', 'agosto': 'August',
                                'settembre': 'September', 'ottobre': 'October', 'novembre': 'November', 'dicembre': 'December',
                                'gen': 'Jan', 'feb': 'Feb', 'mar': 'Mar', 'apr': 'Apr', 'mag': 'May', 'giu': 'Jun',
                                'lug': 'Jul', 'ago': 'Aug', 'set': 'Sep', 'ott': 'Oct', 'nov': 'Nov', 'dic': 'Dec'
                            };
                            for (const [it, en] of Object.entries(monthMap)) {
                                if (out.includes(it)) {
                                    out = out.replace(it, en);
                                    break;
                                }
                            }
                            return out;
                        };
                        // Fast-path per ispionline.it: contenitore .list-item.grid-list, articoli figure.desktop.d, data .date
                        try {
                            var host = new URL(item.url).hostname.toLowerCase();
                            if (/(^|\.)ispionline\.it$/.test(host)) {
                                const container = doc.querySelector('.list-item.grid-list');
                                if (container) {
                                    const articles = Array.from(container.querySelectorAll('figure.desktop.d'));
                                    logToConsole(`[Blog/Generic][ispionline] Contenitore .list-item.grid-list: ${articles.length} articoli (figure.desktop.d)`, 'info');
                                    articles.forEach(function (fig) {
                                        var linkEl = fig.querySelector('a[href]');
                                        if (!linkEl) linkEl = fig.closest('a[href]');
                                        if (!linkEl) return;
                                        const href = linkEl.getAttribute('href');
                                        if (!href) return;
                                        let fullUrl;
                                        try {
                                            fullUrl = new URL(String(href).trim().replace(/[:.,;!?#]+(\/?)$/, '$1'), item.url).href;
                                        } catch (_) { return; }
                                        if (!fullUrl || fullUrl === item.url) return;
                                        if (seenUrls.has(fullUrl) || isAuthorUrl(fullUrl) || isTagOrCategoryArchiveUrl(fullUrl)) return;
                                        var dateEl = fig.querySelector('.date');
                                        if (!dateEl && fig.parentElement) dateEl = fig.parentElement.querySelector('.date');
                                        let dateStr = dateEl ? (dateEl.getAttribute('datetime') || dateEl.getAttribute('data-date') || (dateEl.textContent || '').trim()) : '';
                                        if (!looksLikeRealDate(dateStr)) dateStr = new Date().toISOString().slice(0, 10);
                                        dateStr = normalizeDateStr(dateStr);
                                        var title = (linkEl.textContent || '').trim();
                                        if (!title && fig.querySelector('img[alt]')) title = (fig.querySelector('img[alt]').getAttribute('alt') || '').trim();
                                        if (!title) title = 'No Title';
                                        const recent = isRecent(dateStr);
                                        const status = recent ? 'KEEP' : 'SKIP';
                                        logToConsole(`[Frontend] "${title.substring(0, 30)}" | ${dateStr} | -> ${status}`, recent ? 'success' : 'info');
                                        if (recent) {
                                            pushUniqueArticle(validArticles, {
                                                url: fullUrl,
                                                date: dateStr,
                                                title: title,
                                                source: item.url,
                                                type: 'blog',
                                                listType: item.type
                                            }, seenArticleKeys);
                                            seenUrls.add(fullUrl);
                                            foundForThisUrl++;
                                        }
                                    });
                                    articleRoot = doc.createElement('div');
                                }
                            }
                        } catch (_) {}

                        // Fast-path per nododigordio.org: contenitore .jeg_postblock_5.jeg_postblock, data .jeg_meta_date
                        try {
                            var host2 = new URL(item.url).hostname.toLowerCase();
                            if (/(^|\.)nododigordio\.org$/.test(host2)) {
                                const container = doc.querySelector('.jeg_postblock_5.jeg_postblock');
                                if (container) {
                                    const cards = Array.from(container.querySelectorAll('article, .jeg_post, .jeg_postblock_content, .jeg_posts, .jeg_thumb'));
                                    logToConsole(`[Blog/Generic][nododigordio] Contenitore .jeg_postblock_5.jeg_postblock: ${cards.length} elementi`, 'info');
                                    let used = 0;
                                    cards.forEach(function (card) {
                                        if (!card) return;
                                        var linkEl = card.querySelector('a[href]');
                                        if (!linkEl && card.parentElement) linkEl = card.parentElement.querySelector('a[href]');
                                        if (!linkEl) return;
                                        const href = linkEl.getAttribute('href');
                                        if (!href) return;
                                        let fullUrl;
                                        try {
                                            fullUrl = new URL(String(href).trim().replace(/[:.,;!?#]+(\/?)$/, '$1'), item.url).href;
                                        } catch (_) { return; }
                                        if (!fullUrl || fullUrl === item.url) return;
                                        if (seenUrls.has(fullUrl) || isAuthorUrl(fullUrl) || isTagOrCategoryArchiveUrl(fullUrl)) return;
                                        var dateEl = card.querySelector('.jeg_meta_date, time');
                                        if (!dateEl && card.parentElement) dateEl = card.parentElement.querySelector('.jeg_meta_date, time');
                                        let dateStr = dateEl ? (dateEl.getAttribute('datetime') || dateEl.getAttribute('data-date') || (dateEl.textContent || '').trim()) : '';
                                        if (!looksLikeRealDate(dateStr)) dateStr = new Date().toISOString().slice(0, 10);
                                        dateStr = normalizeDateStr(dateStr);
                                        var title = (linkEl.textContent || '').trim();
                                        if (!title && card.querySelector('img[alt]')) title = (card.querySelector('img[alt]').getAttribute('alt') || '').trim();
                                        if (!title) title = 'No Title';
                                        const recent = isRecent(dateStr);
                                        const status = recent ? 'KEEP' : 'SKIP';
                                        logToConsole(`[Frontend][nododigordio] "${title.substring(0, 40)}" | ${dateStr} | -> ${status}`, recent ? 'success' : 'info');
                                        if (recent) {
                                            pushUniqueArticle(validArticles, {
                                                url: fullUrl,
                                                date: dateStr,
                                                title: title,
                                                source: item.url,
                                                type: 'blog',
                                                listType: item.type
                                            }, seenArticleKeys);
                                            seenUrls.add(fullUrl);
                                            foundForThisUrl++;
                                            used++;
                                        }
                                    });
                                    if (used > 0) {
                                        // Evita doppio parsing generico se il fast-path ha trovato articoli validi
                                        articleRoot = doc.createElement('div');
                                    }
                                }
                            }
                        } catch (_) {}

                        // Fast-path per difesanews.com: articoli in .container, data in .meta_date (classe anche .meta_item.meta_date)
                        try {
                            var hostDn = new URL(item.url).hostname.toLowerCase();
                            if (/(^|\.)difesanews\.com$/.test(hostDn)) {
                                var containersDn = doc.querySelectorAll('.container');
                                var containerDn = null;
                                for (var c = 0; c < containersDn.length; c++) {
                                    if (containersDn[c].querySelector('.meta_date')) {
                                        containerDn = containersDn[c];
                                        break;
                                    }
                                }
                                if (!containerDn) {
                                    if (doc.querySelector('.meta_date')) containerDn = doc.body || doc.documentElement;
                                }
                                if (containerDn) {
                                    var dateElsDn = Array.from((containerDn.querySelectorAll && containerDn.querySelectorAll('.meta_date')) || []);
                                    var usedDn = 0;
                                    dateElsDn.forEach(function (dateEl) {
                                        var card = dateEl.closest('article, .post, .post_item, .item, .entry, .card, [class*="post"]');
                                        if (!card) card = dateEl.closest('div');
                                        if (!card) return;
                                        var links = Array.from(card.querySelectorAll('a[href]'));
                                        var linkEl = null;
                                        var fullUrl = null;
                                        for (var i = 0; i < links.length; i++) {
                                            var href = links[i].getAttribute('href');
                                            if (!href) continue;
                                            try {
                                                var u = new URL(String(href).trim().replace(/[:.,;!?#]+(\/?)$/, '$1'), item.url).href;
                                                if (!u || u === item.url || seenUrls.has(u) || isAuthorUrl(u) || isTagOrCategoryArchiveUrl(u)) continue;
                                                var pathU = (new URL(u)).pathname || '';
                                                if (/^\/notizie\/[^/]+\/?$/.test(pathU)) continue;
                                                fullUrl = u;
                                                linkEl = links[i];
                                                break;
                                            } catch (_) {}
                                        }
                                        if (!linkEl || !fullUrl) return;
                                        var dateStr = (dateEl.getAttribute('datetime') || dateEl.getAttribute('data-date') || (dateEl.textContent || '').trim());
                                        if (!looksLikeRealDate(dateStr)) dateStr = new Date().toISOString().slice(0, 10);
                                        dateStr = normalizeDateStr(dateStr);
                                        var title = (linkEl.textContent || '').trim();
                                        if (!title || /^leggi\s*di\s*più$/i.test(title)) {
                                            var hDn = card.querySelector('h2, h3, .post_title');
                                            if (hDn) title = (hDn.textContent || '').trim();
                                        }
                                        if (!title && card.querySelector('img[alt]')) title = (card.querySelector('img[alt]').getAttribute('alt') || '').trim();
                                        if (!title) title = 'No Title';
                                        var recent = isRecent(dateStr);
                                        var status = recent ? 'KEEP' : 'SKIP';
                                        logToConsole('[Frontend][difesanews] "' + title.substring(0, 40) + '" | ' + dateStr + ' | -> ' + status, recent ? 'success' : 'info');
                                        if (recent) {
                                            pushUniqueArticle(validArticles, {
                                                url: fullUrl,
                                                date: dateStr,
                                                title: title,
                                                source: item.url,
                                                type: 'blog',
                                                listType: item.type
                                            }, seenArticleKeys);
                                            seenUrls.add(fullUrl);
                                            foundForThisUrl++;
                                            usedDn++;
                                        }
                                    });
                                    if (usedDn > 0) {
                                        logToConsole('[Blog/Generic][difesanews] Contenitore .container, .meta_date: ' + usedDn + ' articoli', 'info');
                                        articleRoot = doc.createElement('div');
                                    }
                                }
                            }
                        } catch (_) {}

                        // Fast-path per lantidiplomatico.it: contenitore .post-list.ts-grid-box, data vicino a .fa-clock-o
                        try {
                            var host3 = new URL(item.url).hostname.toLowerCase();
                            if (/(^|\.)lantidiplomatico\.it$/.test(host3)) {
                                const container = doc.querySelector('.post-list.ts-grid-box');
                                if (container) {
                                    const cards = Array.from(container.querySelectorAll('article, .ts-overlay-style, .item, li, .post'));
                                    logToConsole(`[Blog/Generic][lantidiplomatico] Contenitore .post-list.ts-grid-box: ${cards.length} elementi`, 'info');
                                    let usedLd = 0;
                                    cards.forEach(function (card) {
                                        if (!card) return;
                                        var linkEl = card.querySelector('a[href]');
                                        if (!linkEl && card.parentElement) linkEl = card.parentElement.querySelector('a[href]');
                                        if (!linkEl) return;
                                        const href = linkEl.getAttribute('href');
                                        if (!href) return;
                                        let fullUrl;
                                        try {
                                            fullUrl = new URL(String(href).trim().replace(/[:.,;!?#]+(\/?)$/, '$1'), item.url).href;
                                        } catch (_) { return; }
                                        if (!fullUrl || fullUrl === item.url) return;
                                        if (seenUrls.has(fullUrl) || isAuthorUrl(fullUrl) || isTagOrCategoryArchiveUrl(fullUrl)) return;
                                        // Data: cerca l'icona .fa-clock-o e usa il testo del suo contenitore
                                        var clockEl = card.querySelector('.fa-clock-o');
                                        var dateStr = '';
                                        if (clockEl) {
                                            var dateContainer = clockEl.closest('span, div, time, p') || clockEl.parentElement;
                                            if (dateContainer) {
                                                dateStr = (dateContainer.textContent || '').trim();
                                            }
                                        }
                                        if (!looksLikeRealDate(dateStr)) dateStr = new Date().toISOString().slice(0, 10);
                                        dateStr = normalizeDateStr(dateStr);
                                        var title = (linkEl.textContent || '').trim();
                                        if (!title && card.querySelector('img[alt]')) {
                                            title = (card.querySelector('img[alt]').getAttribute('alt') || '').trim();
                                        }
                                        if (!title) title = 'No Title';
                                        const recent = isRecent(dateStr);
                                        const status = recent ? 'KEEP' : 'SKIP';
                                        logToConsole(`[Frontend][lantidiplomatico] "${title.substring(0, 40)}" | ${dateStr} | -> ${status}`, recent ? 'success' : 'info');
                                        if (recent) {
                                            pushUniqueArticle(validArticles, {
                                                url: fullUrl,
                                                date: dateStr,
                                                title: title,
                                                source: item.url,
                                                type: 'blog',
                                                listType: item.type
                                            }, seenArticleKeys);
                                            seenUrls.add(fullUrl);
                                            foundForThisUrl++;
                                            usedLd++;
                                        }
                                    });
                                    if (usedLd > 0) {
                                        // Evita doppio parsing generico se il fast-path ha trovato articoli validi
                                        articleRoot = doc.createElement('div');
                                    }
                                }
                            }
                        } catch (_) {}
                        // Fast-path per ladiscussione: parsing diretto delle card .blog56__item
                        try {
                            var host = new URL(item.url).hostname.toLowerCase();
                            if (/(^|\.)ladiscussione\.com$/.test(host)) {
                                const cards = Array.from(doc.querySelectorAll('.blog56-wrapper.widget56[data-type="post-list"] .blog56__item, .blog56-wrapper[data-type="post-list"] .blog56__item, [data-type="post-list"] .blog56__item'));
                                const postAnchors = Array.from(doc.querySelectorAll('a[href*="/esteri/"]')).filter(a => {
                                    const href = (a.getAttribute('href') || '').trim().toLowerCase();
                                    if (!href) return false;
                                    if (/\/esteri\/?$/.test(href)) return false;
                                    if (/\/esteri\/page\/\d+\/?$/.test(href)) return false;
                                    return true;
                                });
                                logToConsole(`[Blog/Generic][ladiscussione] Card rilevate: ${cards.length} | Link esteri: ${postAnchors.length}`, 'info');
                                let inspected = 0;
                                postAnchors.forEach(a => {
                                    const href = a.getAttribute('href');
                                    if (!href) return;
                                    let fullUrl;
                                    try {
                                        fullUrl = new URL(String(href).trim().replace(/[:.,;!?#]+(\/?)$/, '$1'), item.url).href;
                                    } catch (_) { return; }
                                    if (!fullUrl || fullUrl === item.url) return;
                                    if (seenUrls.has(fullUrl) || isAuthorUrl(fullUrl) || isTagOrCategoryArchiveUrl(fullUrl)) return;
                                    if (!/\/\d+\/esteri\//i.test(fullUrl)) return;

                                    const card = a.closest('.blog56__item, article, li, .post, .item, .card');
                                    let dateStr = null;
                                    if (card) {
                                        const dateEl = card.querySelector('.meta56__item.meta56__date, .meta56__date, [class*="date"][title], time');
                                        if (dateEl) {
                                            dateStr = dateEl.getAttribute('datetime') || dateEl.getAttribute('title') || dateEl.getAttribute('data-date') || (dateEl.textContent || '').trim();
                                        }
                                    }
                                    if (!looksLikeRealDate(dateStr)) {
                                        // Fallback controllato: la lista /esteri/page/N contiene post cronologici recenti.
                                        dateStr = new Date().toISOString().slice(0, 10);
                                    }
                                    inspected++;
                                    dateStr = normalizeDateStr(dateStr);
                                    const title = (a.textContent || '').trim() || 'No Title';
                                    const recent = isRecent(dateStr);
                                    const status = recent ? 'KEEP' : 'SKIP';
                                    logToConsole(`[Frontend] "${title.substring(0, 30)}" | ${dateStr} | -> ${status}`, recent ? 'success' : 'info');
                                    if (recent) {
                                        pushUniqueArticle(validArticles, {
                                            url: fullUrl,
                                            date: dateStr,
                                            title: title,
                                            source: item.url,
                                            type: 'blog',
                                            listType: item.type
                                        }, seenArticleKeys);
                                        seenUrls.add(fullUrl);
                                        foundForThisUrl++;
                                    }
                                });
                                if (inspected > 0) {
                                    // Se il parsing sito-specifico ha trovato card datate, evita doppio parsing generico.
                                    articleRoot = doc.createElement('div');
                                }
                            }
                        } catch (_) {}
                        // Fast-path per ilmessaggero.it (es. sezione mondo): articoli dentro <article>
                        try {
                            var host4 = new URL(item.url).hostname.toLowerCase();
                            if (/(^|\.)ilmessaggero\.it$/.test(host4)) {
                                const container = doc.querySelector('main') || doc.body || doc;
                                const cards = Array.from(container.querySelectorAll('article'));
                                logToConsole(`[Blog/Generic][ilmessaggero] Articoli <article> trovati: ${cards.length}`, 'info');
                                let usedIm = 0;
                                cards.forEach(function (card) {
                                    if (!card) return;
                                    var linkEl = card.querySelector('a[href]');
                                    if (!linkEl && card.parentElement) linkEl = card.parentElement.querySelector('a[href]');
                                    if (!linkEl) return;
                                    const href = linkEl.getAttribute('href');
                                    if (!href) return;
                                    let fullUrl;
                                    try {
                                        fullUrl = new URL(String(href).trim().replace(/[:.,;!?#]+(\/?)$/, '$1'), item.url).href;
                                    } catch (_) { return; }
                                    if (!fullUrl || fullUrl === item.url) return;
                                    if (seenUrls.has(fullUrl) || isAuthorUrl(fullUrl) || isTagOrCategoryArchiveUrl(fullUrl)) return;
                                    // Data: cerca <time> o classi comuni dentro l'article
                                    let dateStr = '';
                                    let dateEl = card.querySelector('time, .date, .data, .article-date, .entry-date, .meta-date');
                                    if (dateEl) {
                                        const timeTag = dateEl.querySelector('time');
                                        if (timeTag) {
                                            dateStr = timeTag.getAttribute('datetime') || timeTag.textContent;
                                        } else {
                                            dateStr =
                                                dateEl.getAttribute('datetime') ||
                                                dateEl.getAttribute('title') ||
                                                dateEl.getAttribute('data-date') ||
                                                (dateEl.textContent || '').trim();
                                        }
                                    }
                                    if (!looksLikeRealDate(dateStr)) {
                                        dateStr = new Date().toISOString().slice(0, 10);
                                    }
                                    dateStr = normalizeDateStr(dateStr);
                                    var title = (linkEl.textContent || '').trim();
                                    if (!title && card.querySelector('h1, h2, h3')) {
                                        title = (card.querySelector('h1, h2, h3').textContent || '').trim();
                                    }
                                    if (!title && card.querySelector('img[alt]')) {
                                        title = (card.querySelector('img[alt]').getAttribute('alt') || '').trim();
                                    }
                                    if (!title) title = 'No Title';
                                    const recent = isRecent(dateStr);
                                    const status = recent ? 'KEEP' : 'SKIP';
                                    logToConsole(`[Frontend][ilmessaggero] "${title.substring(0, 40)}" | ${dateStr} | -> ${status}`, recent ? 'success' : 'info');
                                    if (recent) {
                                        pushUniqueArticle(validArticles, {
                                            url: fullUrl,
                                            date: dateStr,
                                            title: title,
                                            source: item.url,
                                            type: 'blog',
                                            listType: item.type
                                        }, seenArticleKeys);
                                        seenUrls.add(fullUrl);
                                        foundForThisUrl++;
                                        usedIm++;
                                    }
                                });
                                if (usedIm > 0) {
                                    // Evita doppio parsing generico se il fast-path ha trovato articoli validi
                                    articleRoot = doc.createElement('div');
                                }
                            }
                        } catch (_) {}
                        let linkList;
                        if (articleRoot) {
                            linkList = articleRoot.querySelectorAll('a');
                        } else {
                            linkList = doc.querySelectorAll('a');
                        }
                        const links = Array.from(linkList).filter(el => !isExcluded(el));

                        links.forEach(el => {
                            const href = el.getAttribute('href');
                            if (!href) return;
                            
                            let fullUrl;
                            try {
                                // Aggressive cleaning: trim whitespace and remove trailing punctuation/symbols
                                // Regex handles cases like ":", "/:", ".:", etc.
                                let cleanHref = href.trim().replace(/[:.,;!?#]+(\/?)$/, '$1');
                                fullUrl = new URL(cleanHref, item.url).href;
                                
                                // Double check on full URL
                                const originalFull = fullUrl;
                                fullUrl = fullUrl.replace(/[:.,;!?#]+(\/?)$/, '$1');
                                
                                if (originalFull !== fullUrl) {
                                    console.log(`[DEBUG] Cleaned URL: ${originalFull} -> ${fullUrl}`);
                                }
                                
                            } catch(e) { return; }
                            
                            if (fullUrl === item.url) return;
                            if (seenUrls.has(fullUrl)) return;
                            if (isAuthorUrl(fullUrl)) return; // ignora pagine autore
                            if (isTagOrCategoryArchiveUrl(fullUrl)) return; // ignora /tag/xxx, /category/xxx (Ghost, WP)
                            // URL che punta solo a ancoraggio (stesso articolo): #comments, #respond
                            try {
                                const u = new URL(fullUrl);
                                if (/^#?(comments|respond|reply)$/i.test((u.hash || '').replace(/^#/, ''))) return;
                            } catch (_) {}
                            var linkTextNorm = (el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
                            if (!linkTextNorm) return; // link vuoto
                            // Read more, Comments, Leggi altro, ecc. (anche se seguiti da titolo: "Leggi di più "Titolo" »")
                            if (/^(read\s*more|leggi\s*(tutto|altro|di\s*più)|continua\s*(a\s*leggere)?|commenti?|comments?|rispondi|reply|condividi|share|altri\s*articoli|other\s*posts?|segui\s*@|follow\s*@|iscriviti|subscribe|contacts?|contatti)(\s*[»…]|\s*\.\.\.)?$/i.test(linkTextNorm)) return;
                            if (/^(leggi\s*(?:tutto|altro|di\s*più)|read\s*more)\s+/i.test(linkTextNorm)) return;
                            // "Posted on...", "Pubblicato il..." (Grandeinganno, WordPress)
                            if (/^(posted\s*on|pubblicato\s*(il)?)\s+/i.test(linkTextNorm)) return;
                            // "0 Comments", "1 Comment", "2 Commenti", "Nessun commento", ecc.
                            if (/^\d+\s*commenti?$/i.test(linkTextNorm) || /^\d+\s*comments?$/i.test(linkTextNorm)) return;
                            if (/^nessun\s*commento\s*/i.test(linkTextNorm)) return;
                            // Link con testo SOLO data (archivio per data, non articolo): "19 Febbraio 2026", "20 Feb 2026"
                            if (/^\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$/i.test(linkTextNorm)) return;
                            // Etichette categoria comuni (es. NoGeoingegneria: "News (ITA)", "OPINIONI")
                            if (/^news\s*\((?:ita|eng|it|en)\)$/i.test(linkTextNorm)) return;

                            let dateStr = null;
                            
                            // 1. Check <time>
                            const timeInside = el.querySelector('time');
                            if (timeInside) {
                                dateStr = timeInside.getAttribute('datetime') || timeInside.textContent;
                            }
                            
                            // 2. Regex: date assolute e relative ("8 ore fa", "1 ora fa", "7 giorni fa")
                            if (!dateStr) {
                                 const dateRegex = /(\d{4}-\d{2}-\d{2})|(\d{1,2}\/\d{1,2}\/\d{4})|(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Gen|Feb|Mar|Apr|Mag|Giu|Lug|Ago|Set|Ott|Nov|Dic)[a-z]*\s+\d{4})/i;
                                 const relRegex = /(\d+)\s*(?:ora|ore|minuto|minuti|giorno|giorni)\s+fa/i;
                                 const linkText = el.textContent;
                                 let match = linkText.match(dateRegex) || linkText.match(relRegex);
                                 if (match) dateStr = match[0];
                                 if (!dateStr && el.parentElement) {
                                     const parentText = el.parentElement.textContent;
                                     match = parentText.match(dateRegex) || parentText.match(relRegex);
                                     if (match) dateStr = match[0];
                                 }
                            }
                            
                            // 3. Check for specific date classes (New Feature)
                            if (!dateStr) {
                                // Look up the tree for common date containers
                                const container = el.closest('article, .td_module_wrap, .tdb_loop_item, .blog56__item, .post-item, .entry-item, li, .post, .card, .widget, .item, .post-card, .blog56-wrapper, .widget56, [data-type="post-list"], .articles-list li, .articles-list .item, .articles-list div, .jeg_postblock_5.jeg_postblock');
                                if (container) {
                                    const dateClasses = [
                                        '.date',  // ANSA e altri
                                        '.tgme_widget_message_date', // Specific for Telegram
                                        '.social-date__text', 
                                        '.entry-published',
                                        '.time', '.published', '.meta-date', '.post-date', '.entry-date',
                                        '.entry-date.updated.td-module-date', '.td-module-date',  // Newspaper/tagDiv (lindipendente.online)
                                        '.meta56__date', '.meta56__item.meta56__date', '.jeg_meta_date',
                                        '.date56', '.meta56', '.post-meta', '.entry-meta',
                                        '.datetime', '.timestamp', '.article-date',
                                        '.post-info'  // Ghost CMS (Lookout, ecc.): contiene <time datetime="...">
                                    ];
                                    
                                    for (const cls of dateClasses) {
                                        const dateEl = container.querySelector(cls);
                                        if (dateEl) {
                                            // Special handling for Telegram time tag inside date container
                                            const timeTag = dateEl.querySelector('time');
                                            if (timeTag) {
                                                dateStr = timeTag.getAttribute('datetime') || timeTag.textContent;
                                            } else {
                                                dateStr =
                                                    dateEl.getAttribute('datetime') ||
                                                    dateEl.getAttribute('title') ||
                                                    dateEl.getAttribute('data-date') ||
                                                    dateEl.textContent.trim();
                                            }
                                            if (looksLikeRealDate(dateStr)) break;
                                            dateStr = null;
                                        }
                                    }
                                    // Fallback: qualunque <time> nel contenitore (Ghost, ecc.)
                                    if (!dateStr) {
                                        const timeEl = container.querySelector('time');
                                        if (timeEl) {
                                            var dtCandidate = timeEl.getAttribute('datetime') || timeEl.textContent;
                                            if (looksLikeRealDate(dtCandidate)) dateStr = dtCandidate;
                                        }
                                    }
                                }
                            }
                        
                        // Normalize Italian Dates & Partial Dates
                        if (dateStr) {
                            dateStr = dateStr.toLowerCase().trim();
                            
                            // Handle partial MM-DD format (e.g. 02-20)
                            // Regex for MM-DD or DD-MM (simple check)
                            const partialMatch = dateStr.match(/^(\d{1,2})[-/](\d{1,2})$/);
                            if (partialMatch) {
                                const currentYear = new Date().getFullYear();
                                dateStr = `${currentYear}-${partialMatch[1]}-${partialMatch[2]}`; // Assume YYYY-MM-DD
                            }

                            const monthMap = {
                                'gennaio': 'January', 'febbraio': 'February', 'marzo': 'March', 'aprile': 'April',
                                'maggio': 'May', 'giugno': 'June', 'luglio': 'July', 'agosto': 'August',
                                'settembre': 'September', 'ottobre': 'October', 'novembre': 'November', 'dicembre': 'December',
                                'gen': 'Jan', 'feb': 'Feb', 'mar': 'Mar', 'apr': 'Apr', 'mag': 'May', 'giu': 'Jun',
                                'lug': 'Jul', 'ago': 'Aug', 'set': 'Sep', 'ott': 'Oct', 'nov': 'Nov', 'dic': 'Dec'
                            };
                            for (const [it, en] of Object.entries(monthMap)) {
                                if (dateStr.includes(it)) {
                                    dateStr = dateStr.replace(it, en);
                                    break; 
                                }
                            }
                        }
                            
                            const shortUrl = fullUrl.length > 40 ? fullUrl.substring(0, 37) + '...' : fullUrl;
                            const linkTitle = el.textContent.trim().substring(0, 30);

                            if (dateStr) {
                                const recent = isRecent(dateStr);
                                const status = recent ? "KEEP" : "SKIP";
                                
                                // Log visible in browser console UI
                                logToConsole(`[Frontend] "${linkTitle}" | ${dateStr} | -> ${status}`, recent ? 'success' : 'info');
                                
                                if (recent) {
                                    pushUniqueArticle(validArticles, {
                                        url: fullUrl,
                                        date: dateStr,
                                        title: el.textContent.trim() || "No Title",
                                        source: item.url,
                                        type: 'blog',
                                        listType: item.type
                                    }, seenArticleKeys);
                                    seenUrls.add(fullUrl);
                                    foundForThisUrl++;
                                }
                            }
                        });
                    }
                    
                    logToConsole(`Finito ${item.url}: Trovati ${foundForThisUrl} elementi recenti.`, foundForThisUrl > 0 ? 'success' : 'warn');
                    
                } else if (item.error) {
                    logToConsole(`[${item.url}] ERRORE: ${item.error}`, 'error');
                }
            });
        }

// Fase 1B: verifica pertinenza (question_pertinente); aggiorna currentArticles e restituisce lista scartati per log
async function runFase1B() {
    if (currentArticles.length === 0) return [];
    var limit = getParallelAnalyzeLimit();
    var logShowResponses = !!(document.getElementById('log-show-responses') && document.getElementById('log-show-responses').checked);
    logToConsole('--- INIZIO FASE 1B: Verifica pertinenza (parallelo fino a ' + limit + ') ---', 'info');
    var fillEl = document.getElementById('progress-bar-fill');
    if (fillEl) fillEl.classList.add('phase1b');
    var pertinent = [];
    var scartati = [];
    var idx = 0;
    var processed = 0;
    var articles = currentArticles.slice();
    for (var k = 0; k < articles.length; k++) {
        var u = (articles[k].url || '').trim().replace(/[:.,;!?#]+(\/?)$/, '$1');
        if (u) articles[k].url = u;
    }
    articles = articles.filter(function (a) { return a.url; });

    // Inizializza esplicitamente lo stato della progress bar per la Fase 1B
    progressState.total = articles.length;
    progressState.elaborated = 0;
    progressState.inFile = 0;
    setProgressPhase('fase1b', { pertinenti: 0, pertinentiTotal: articles.length });
    updateProgressBar(articles.length, 0, 0);

    var checkOne = async function (article) {
        var body = { url: article.url, title: article.title, type: article.type || article.listType, max_concurrent: limit };
        // Pipeline YouTube: 1) verifica data (nel server) + estrazione trascrizione  2) verifica PERTINENTE sulla trascrizione (come Telegram)
        if ((article.type === 'youtube' || article.listType === 'youtube') && article.url) {
            try {
                logToConsole('[YouTube] Verifica data e trascrizione: ' + (article.title || article.url), 'info');
                var trRes = await fetch('/api/youtube-transcript', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: article.url, video_id: article.youtube_video_id || getYoutubeVideoIdFromUrl(article.url) }),
                    signal: analyzeAbortController ? analyzeAbortController.signal : undefined
                });
                var trData = await trRes.json();
                if (trRes.ok && trData && trData.success && trData.transcript) {
                    body.text = trData.transcript;
                    article.text = trData.transcript;
                    logToConsole('[YouTube] Data OK, trascrizione OK (' + (trData.source || '') + ') — verifica pertinenza sulla trascrizione.', 'success');
                } else {
                    var trErr = (trData && (trData.error || trData.message)) ? (trData.error || trData.message) : ('HTTP ' + trRes.status);
                    logToConsole('[YouTube] ' + trErr, 'warn');
                    if (/troppo vecchio|troppo vecchia/i.test(String(trErr))) {
                        return {
                            article: article,
                            pertinente: 'NON PERTINENTE',
                            nota: 'YouTube: data non pertinente (' + trErr + ')',
                            notizia: '',
                            error: null
                        };
                    }
                    return {
                        article: article,
                        pertinente: 'NON PERTINENTE',
                        nota: 'YouTube: trascrizione non disponibile o errore',
                        notizia: '',
                        error: null
                    };
                }
            } catch (ytErr) {
                logToConsole('[YouTube] Errore trascrizione: ' + ytErr.message, 'error');
                return {
                    article: article,
                    pertinente: 'NON PERTINENTE',
                    nota: 'YouTube: errore trascrizione — ' + ytErr.message,
                    error: ytErr.message
                };
            }
        }

        if (article.html && !body.text) body.html = article.html;
        if (article.text && !body.text) body.text = article.text;
        try {
            var res = await fetch('/api/check-pertinente', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: analyzeAbortController ? analyzeAbortController.signal : undefined
            });
            var data = await res.json();

            return {
                article: article,
                pertinente: data.pertinente,
                nota: data.nota || '',
                notizia: data.notizia || '',
                error: data.error
            };
        } catch (e) {
            if (e && e.name === 'AbortError') {
                return { article: article, pertinente: 'NON PERTINENTE', nota: 'Interrotto da STOP', error: null, aborted: true };
            }
            return { article: article, pertinente: 'NON PERTINENTE', nota: e.message || 'Errore richiesta', error: e.message };
        }
    };

    try {
        while (idx < articles.length) {
            if (abortElaboration) {
                logToConsole('--- Fase 1B interrotta dall\'utente. ---', 'warn');
                break;
            }
            // PRENDIAMO UN BATCH DI 'limit' ARTICOLI PER IL PARALLELISMO
            var batch = articles.slice(idx, idx + limit);
            idx += batch.length;
            
            logToConsole('[Fase 1B] Verifica pertinenza parallela di ' + batch.length + ' articoli...', 'info');
            
            // ESEGUIAMO IN PARALLELO
            var batchResults = await Promise.all(batch.map(function (article) {
                incrementActiveAgents();
                return checkOne(article).then(function (r) {
                    decrementActiveAgents();
                    processed++;
                    if (r && r.aborted) {
                        setProgressPhase('fase1b', { pertinenti: pertinent.length, pertinentiTotal: articles.length });
                        updateProgressBar(articles.length, processed, 0);
                        return r;
                    }
                    var titleOrUrl = (r.article.title || r.article.url || '').substring(0, 60);
                    var shortUrl = (r.article.url || '').substring(0, 120);
                    var noteSuffix = (logShowResponses && r.nota)
                        ? (' — Nota: ' + r.nota.substring(0, 200) + (r.nota.length > 200 ? '…' : ''))
                        : '';
                    if (r.pertinente === 'PERTINENTE') {
                        r.article.pertinente_nota = r.nota;
                        if (r.notizia) r.article.pertinente_notizia = r.notizia;
                        pertinent.push(r.article);
                        logToConsole('[Fase 1B][ACCETTATO] ' + titleOrUrl + (shortUrl ? ' | ' + shortUrl : '') + noteSuffix, 'success');
                    } else {
                        scartati.push({ title: r.article.title, url: r.article.url, nota: r.nota });
                        logToConsole('[Fase 1B][SCARTATO] ' + titleOrUrl + (shortUrl ? ' | ' + shortUrl : '') + noteSuffix, 'info');
                    }
                    setProgressPhase('fase1b', { pertinenti: pertinent.length, pertinentiTotal: articles.length });
                    updateProgressBar(articles.length, processed, 0);
                    return r; // Ritorniamo il risultato per completezza
                });
            }));
            
            // Qui batchResults contiene i risultati del blocco corrente, già processati nei .then()
        }
        currentArticles = pertinent;
        logToConsole('--- FASE 1B COMPLETATA: ' + pertinent.length + ' pertinenti, ' + scartati.length + ' scartati ---', 'success');
    } finally {
        if (fillEl) fillEl.classList.remove('phase1b');
    }

    // Log web: accettati e scartati (con note se Risposte attivo)
    logToConsole('--- Accettati (' + pertinent.length + ') ---', 'info');
    pertinent.forEach(function (a, i) {
        var line = (i + 1) + '. ' + (a.title || a.url || '').substring(0, 70);
        if (logShowResponses && a.pertinente_nota) line += ' — ' + a.pertinente_nota.substring(0, 120) + (a.pertinente_nota.length > 120 ? '…' : '');
        logToConsole(line, 'success');
    });
    logToConsole('--- Scartati (' + scartati.length + ') ---', 'info');
    scartati.forEach(function (s, i) {
        var line = (i + 1) + '. ' + (s.title || s.url || '').substring(0, 70);
        if (logShowResponses && s.nota) line += ' — ' + s.nota.substring(0, 120) + (s.nota.length > 120 ? '…' : '');
        logToConsole(line, 'info');
    });

    return scartati;
}

        // Send valid articles back to server
        // Se abbiamo raccolto link secondari (es. da post Telegram), inviali al backend in un solo batch
        if (secondaryLinksQueue.length > 0) {
            try {
                var batch = secondaryLinksQueue.filter(function (e) { return e && e.url; });
                // De-duplica lato client per sicurezza
                var seenSec = new Set();
                batch = batch.filter(function (e) {
                    var u = String(e.url || '').trim();
                    if (!u || seenSec.has(u)) return false;
                    seenSec.add(u);
                    return true;
                });
                await Promise.all(batch.map(function (e) {
                    return fetch('/api/link-secondari/add', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: e.url, date: e.date })
                    }).catch(function () {});
                }));
                logToConsole('Link secondari da Telegram salvati in link_secondari.json: ' + batch.length, 'info');
            } catch (e) {
                logToConsole('Errore salvataggio link secondari: ' + e.message, 'warn');
            } finally {
                secondaryLinksQueue = [];
            }
        }

        if (validArticles.length > 0) {
            setProgressPhase('raccolta', { accepted: validArticles.length, acceptedTotal: validArticles.length });
            updateProgressBar(validArticles.length, validArticles.length);
            logToConsole(`Invio ${validArticles.length} articoli al server...`, 'warn');
            await fetch('/api/save-articles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(validArticles)
            });
            logToConsole('Articoli salvati con successo.', 'success');
            await refreshArticlesDateRangeLabel();
            logToConsole('Scritto articolielaborati.json', 'info');
            try {
                await fetch('/api/articolielaborati-sort', { method: 'POST' });
            } catch (_) {}

            var preFase1BArticles = validArticles.slice();
            try {
                var existingResPre = await fetch('/api/articolielaborati');
                if (existingResPre.ok) {
                    var existingDataPre = await existingResPre.json();
                    var existingPre = Array.isArray(existingDataPre) ? existingDataPre : [];
                    var existingValidSetPre = new Set();
                    for (var exi = 0; exi < existingPre.length; exi++) {
                        var ex = existingPre[exi] || {};
                        if (!(typeof ex.notizia === 'string' && ex.notizia.trim())) continue;
                        var exKey = normalizeArticleUrlForDedup(ex.url || '');
                        if (exKey) existingValidSetPre.add(exKey);
                    }
                    if (existingValidSetPre.size > 0) {
                        var skipPre = [];
                        preFase1BArticles = preFase1BArticles.filter(function (a) {
                            var k = normalizeArticleUrlForDedup(a.url || '');
                            var isDup = !!(k && existingValidSetPre.has(k));
                            if (isDup) skipPre.push(a);
                            return !isDup;
                        });
                        if (skipPre.length > 0) {
                            logToConsole('[Pre-Fase 1B] Link gia presenti in articolielaborati: ' + skipPre.length + ' -> question_pertinente non inviata.', 'info');
                            skipPre.forEach(function (a, i) {
                                var t = String(a.title || '').trim();
                                var u = String(a.url || '').trim();
                                var lbl = t ? (t + ' | ' + u) : u;
                                if (a && a.type === 'telegram') {
                                    logToConsole('[Fase 1B][PRESENTE][TELEGRAM] ' + lbl + ' -> salto question_pertinente.', 'warn');
                                } else {
                                    logToConsole('[Fase 1B][PRESENTE] ' + lbl + ' -> salto question_pertinente.', 'warn');
                                }
                                logToConsole('[Pre-Fase 1B][GIA PRESENTE #' + (i + 1) + '] ' + lbl + ' -> salto question_pertinente.', 'info');
                            });
                        }
                    }
                }
            } catch (e) {
                logToConsole('[Pre-Fase 1B] Verifica duplicati non riuscita: ' + e.message, 'warn');
            }

            currentArticles = preFase1BArticles;
            setProgressPhase('raccolta', { accepted: currentArticles.length, acceptedTotal: validArticles.length });
            updateProgressBar(validArticles.length, currentArticles.length);
            if (currentArticles.length > 0) {
            await runFase1B();
            } else {
                logToConsole('Tutti i link trovati sono gia presenti in articolielaborati: salto Fase 1B.', 'info');
            }

            // Non sostituire articles.json: deve restare in append (dedup lato backend su URL normalizzato).

            var debugCb = document.getElementById('debug-one-article');
            var debugActive = !!(debugCb && debugCb.checked);
            if (debugActive && currentArticles.length > 1) {
                currentArticles = currentArticles.slice(0, 1);
                logToConsole('Limita a 1 Articolo attivo: uso solo il primo articolo pertinente per le fasi successive.', 'warn');
            }

            var onlySearchCb = document.getElementById('only-search-phase');
            var onlySearch = !!(onlySearchCb && onlySearchCb.checked);

            if (currentArticles.length === 0) {
                logToConsole('Nessun articolo pertinente dopo Fase 1B. Fase 2 non avviata.', 'warn');
            } else if (onlySearch) {
                logToConsole('Solo fase ricerca articoli attiva: processo fermato dopo la Fase 1B, senza analisi IA e sintesi.', 'warn');
            } else {
                logToConsole('Avvio automatico FASE 2: Analisi articoli...', 'success');
                await analyzeFoundArticles();
            }
        } else {
            setProgressPhase('raccolta', { accepted: 0, acceptedTotal: 0 });
            updateProgressBar(0, 0);
            logToConsole('Nessun articolo recente trovato.', 'warn');
            // document.getElementById('analyze-btn').style.display = 'none';
        }
    } catch (err) {
        if (err && err.name === 'AbortError') {
            logToConsole('Scaricamento HTML annullato (STOP).', 'warn');
        } else {
            logToConsole('Errore in processUrls: ' + (err && err.message ? err.message : err), 'error');
        }
    } finally {
        var stoppedByUser = abortElaboration === true;
        setRunHistoryDedupContext(null);
        releaseAbortController(processAbortController);
        processAbortController = null;
        setStartStopButton(false);
        elaborationInProgress = false;
        abortElaboration = false;
        resetActiveAgents();
        if (stoppedByUser) {
            logToConsole('--- ELABORAZIONE INTERROTTA (STOP) ---', 'warn');
        } else {
            logToConsole('--- ELABORAZIONE TERMINATA ---', 'info');
        }
        if (!stoppedByUser) {
            var autoSendEmailEnabled = !!(document.getElementById('auto-send-email') && document.getElementById('auto-send-email').checked);
            if (autoSendEmailEnabled) {
                await openVisionEmail({ silent: true });
            }
            var planned = scheduleNextBatchIfNeeded();
            if (resultsDiv) resultsDiv.textContent = planned ? ('Elaborazione completata. Prossimo batch tra ' + formatBatchWaitLabel(getBatchWaitMinutes()) + '.') : 'Elaborazione completata.';
        } else {
            if (resultsDiv) resultsDiv.textContent = 'Elaborazione interrotta.';
        }
    }

async function analyzeFoundArticles() {
    if (currentArticles.length === 0) {
        logToConsole('Nessun articolo da analizzare.', 'error');
        return;
    }

    analyzeAbortController = registerAbortController(new AbortController());
    logToConsole('--- INIZIO FASE 2: ANALISI AI (parallelo fino a ' + getParallelAnalyzeLimit() + ') ---', 'info');

    const customQuestion = '';
    let articles = currentArticles.map(a => ({
        ...a,
        url: (a.url || '').trim().replace(/[:.,;!?#]+(\/?)$/, '$1')
    })).filter(a => a.url);
    try {
        var existingRes = await fetch('/api/articolielaborati');
        if (existingRes.ok) {
            var existingData = await existingRes.json();
            var existing = Array.isArray(existingData) ? existingData : [];
            var existingSet = new Set();
            for (var ei = 0; ei < existing.length; ei++) {
                var e0 = existing[ei] || {};
                var resp = e0.response;
                if (!Array.isArray(resp) || resp.length === 0) continue;
                if (!(typeof e0.notizia === 'string' && e0.notizia.trim())) continue;
                var ek = normalizeArticleUrlForDedup(e0.url || '');
                if (ek) existingSet.add(ek);
            }
            if (existingSet.size > 0) {
                var beforeCount = articles.length;
                var skippedDuplicateArticles = [];
                articles = articles.filter(function (a) {
                    var k = normalizeArticleUrlForDedup(a.url || '');
                    var isDup = !!(k && existingSet.has(k));
                    if (isDup) skippedDuplicateArticles.push(a);
                    return !isDup;
                });
                var skippedDup = beforeCount - articles.length;
                if (skippedDup > 0) {
                    logToConsole('[Fase 2] Skip duplicati: ' + skippedDup + ' link gia presenti in articolielaborati.json.', 'info');
                    skippedDuplicateArticles.forEach(function (a, i) {
                        var title = String(a.title || '').trim();
                        var u = String(a.url || '').trim();
                        var label = title ? (title + ' | ' + u) : u;
                        logToConsole('[Fase 2][GIA PRESENTE #' + (i + 1) + '] ' + label + ' -> salto analisi.', 'info');
                    });
                }
            }
        }
    } catch (e) {
        logToConsole('[Fase 2] Controllo duplicati su articolielaborati non riuscito: ' + e.message, 'warn');
    }
    var debugCb = document.getElementById('debug-one-article');
    var debugOne = !!(debugCb && debugCb.checked);
    if (debugOne) {
        logToConsole('Limita a 1 Articolo: raccolta si ferma al primo articolo dichiarato PERTINENTE, poi si prosegue con le altre fasi.', 'info');
    }
    if (TEST_MAX_ARTICOLI > 0) {
        articles = articles.slice(0, TEST_MAX_ARTICOLI);
        logToConsole('TEST: elaborazione limitata a ' + TEST_MAX_ARTICOLI + ' articoli.', 'info');
    }

    var inFileCount = 0;
    try {
        var startCountRes = await fetch('/api/articolielaborati-count');
        var startCountData = await startCountRes.json();
        if (startCountData && startCountData.count !== undefined && startCountData.count !== null) {
            inFileCount = Number(startCountData.count) || 0;
        }
    } catch (_) {}
    var countEl = document.getElementById('articolielaborati-count');
    if (countEl) countEl.textContent = String(inFileCount);
    setProgressPhase('fase2');
    updateProgressBar(articles.length, 0, inFileCount);

    var logShowQuestions = !!(document.getElementById('log-show-questions') && document.getElementById('log-show-questions').checked);
    var logShowResponses = !!(document.getElementById('log-show-responses') && document.getElementById('log-show-responses').checked);
    function previewResp(v) {
        var s = (v == null) ? '' : String(v);
        return s.length > 2000 ? (s.substring(0, 2000) + '...') : s;
    }

    const oneRequest = async (article) => {
        try {
            var invioTitolo = String(article.title || article.url || 'articolo').replace(/[\s]+/g, ' ').trim();
            if (invioTitolo.length > 120) invioTitolo = invioTitolo.substring(0, 120) + '…';
            if (logShowQuestions) logToConsole('[question_per_article] Invio: ' + invioTitolo, 'info');
            const body = { url: article.url, title: article.title, question: customQuestion || undefined };
            if (article.html) body.html = article.html;
            if (article.text) body.text = article.text;
            if (article.type) body.type = article.type;
            else if (article.listType) body.type = article.listType;
            if (article.date) body.article_date = article.date;
            if (article.pertinente_notizia) body.notizia = article.pertinente_notizia;
            if (debugOne) body.debug = true;
            if (forceSintesiEachValid) body.sintesi = true;
            body.max_concurrent = getParallelAnalyzeLimit();
            if (logShowQuestions) {
                try {
                    var bodyStr = JSON.stringify(body);
                    logToConsole('[IA invio] ' + (bodyStr.length > 2000 ? bodyStr.substring(0, 2000) + '...' : bodyStr), 'info');
                } catch (_) {}
            }
            const aiRes = await fetch('/api/analyze-article', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: analyzeAbortController ? analyzeAbortController.signal : undefined
            });
            const text = await aiRes.text();
            if (!aiRes.ok) {
                return { article, aiData: { error: 'HTTP ' + aiRes.status + (text && text.length < 200 ? ': ' + text.replace(/<[^>]+>/g, ' ').trim() : '') }, error: null };
            }
            let aiData;
            try {
                aiData = JSON.parse(text);
            } catch (e) {
                return { article, aiData: { error: 'Risposta non JSON (probabile errore server). Controlla la console.' }, error: null };
            }
            return { article, aiData, error: null };
        } catch (err) {
            if (err && err.name === 'AbortError') {
                return { article, aiData: null, error: null, aborted: true };
            }
            return { article, aiData: null, error: err };
        }
    };

    let idx = 0;
    var totalCompleted = 0;

    var stoppedByUser = false;
    var testGotFirstValid = false;
    while (idx < articles.length) {
        if (abortElaboration) {
            stoppedByUser = true;
            logToConsole('--- Elaborazione interrotta dall\'utente (STOP). ---', 'warn');
            break;
        }
        const limit = getParallelAnalyzeLimit();
        const batch = articles.slice(idx, idx + limit);
        idx += batch.length;
        logToConsole('[Batch] Analisi parallela di ' + batch.length + ' articoli...', 'info');

        var safeLabel = function (a) {
            var s = String(a.title || a.url || '');
            return s.replace(/[^\x20-\x7E\u00A0-\u024F]/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 80) || a.url || 'articolo';
        };
        const results = await Promise.all(batch.map(article => {
            incrementActiveAgents();
            return oneRequest(article).then(function (result) {
                decrementActiveAgents();
                totalCompleted++;
                updateProgressBar(articles.length, totalCompleted);
                var lab = safeLabel(result.article);
                if (result && result.aborted) {
                    logToConsole('Articolo: ' + lab + ' — annullato da STOP', 'warn');
                } else if (result.error) {
                    logToConsole('Articolo: ' + lab + ' — Risposta ricevuta: SCARTATO (errore: ' + (result.error.message || 'unknown') + ')', 'error');
                } else if (!result.aiData || typeof result.aiData !== 'object') {
                    logToConsole('Articolo: ' + lab + ' — Risposta ricevuta: SCARTATO (risposta vuota o non valida)', 'warn');
                } else if (result.aiData.skipped) {
                    var skipReason = result.aiData.reason || 'risposta non valida';
                    var isDuplicateSkip = !!(result.aiData.duplicate === true || /gia presente/i.test(skipReason));
                    if (isDuplicateSkip) {
                        logToConsole('Articolo: ' + lab + ' — Risposta ricevuta: GIA PRESENTE IN articolielaborati.json -> SALTATO', 'info');
                    } else {
                        logToConsole('Articolo: ' + lab + ' — Risposta ricevuta: SCARTATO (' + skipReason + ')', 'warn');
                    }
                } else if (result.aiData.error) {
                    logToConsole('Articolo: ' + lab + ' — Risposta ricevuta: SCARTATO (errore IA: ' + result.aiData.error + ')', 'error');
                } else if (result.aiData.analysis) {
                    var c = result.aiData.articolielaborati_valid_count;
                    logToConsole('Articolo: ' + lab + ' — Risposta ricevuta: ACCETTATO' + (c != null ? ' (inseriti in file: ' + c + ')' : ''), 'success');
                    if (c !== undefined && c !== null) {
                        inFileCount = Number(c) || 0;
                        var countElRt = document.getElementById('articolielaborati-count');
                        if (countElRt) countElRt.textContent = String(inFileCount);
                        updateProgressBar(articles.length, totalCompleted, inFileCount);
                        // Fase 3 sintesi solo a fine elaborazione (non ogni N articoli)
                    }
                } else {
                    logToConsole('Articolo: ' + lab + ' — Risposta ricevuta: esito non riconosciuto', 'warn');
                }
                return result;
            });
        }));

        for (const { article, aiData, error, aborted } of results) {
            const label = safeLabel(article);
            if (aborted) {
                continue;
            }
            if (error) {
                logToConsole('[AI ERROR] ' + label + ': ' + (error && error.message ? error.message : ''), 'error');
                continue;
            }
            if (!aiData || typeof aiData !== 'object') {
                continue;
            }
            var aiDataPreview = '';
            try {
                var aiDataStr = JSON.stringify(aiData);
                aiDataPreview = aiDataStr.length > 1200 ? (aiDataStr.substring(0, 1200) + '...') : aiDataStr;
            } catch (_) {
                aiDataPreview = '[risposta non serializzabile]';
            }
            if (aiData.skipped) {
                var reason = aiData.reason || 'risposta non valida';
                var isDupSkip = !!(aiData.duplicate === true || /gia presente/i.test(reason));
                if (isDupSkip) {
                    logToConsole('[SKIP DUPLICATO] ' + label + ': gia presente in articolielaborati.json -> prossimo.', 'info');
                } else {
                logToConsole('[SKIP] ' + label + ': ' + reason + ' -> prossimo.', 'info');
                }
                if (logShowResponses) logToConsole('[IA risposta] ' + aiDataPreview, 'info');
                continue;
            }
            if (aiData.error) {
                logToConsole('[AI ERROR] ' + label + ': ' + aiData.error, 'error');
                if (logShowResponses) logToConsole('[IA risposta] ' + aiDataPreview, 'info');
                continue;
            }
            if (aiData.analysis) {
                var count = aiData.articolielaborati_valid_count;
                logToConsole('[AI] Valido: ' + (article.title || article.url) + (count != null ? ' — Articoli validi: ' + count : ''), 'success');
                if (count !== undefined && count !== null) {
                    inFileCount = Number(count) || 0;
                    var countEl = document.getElementById('articolielaborati-count');
                    if (countEl) countEl.textContent = String(inFileCount);
                    updateProgressBar(articles.length, totalCompleted, inFileCount);
                }
                if (aiData.phase3_updated || aiData.sintesi_updated) {
                    logToConsole('Fase 3 (solo a fine elaborazione).', 'info');
                    await refreshNationSintesiAlternativa();
                    await refreshNationEmwaIa();
                    await refreshNationNote();
                    await refreshNationAggregate();
                    await refreshNationSintesi();
                    await refreshNationSintesiV4();
                    hideMapTooltips();
                }
                if (logShowResponses) logToConsole('[IA risposta] ' + aiDataPreview, 'info');
                article.analysis = aiData.analysis;
                if (debugOne) testGotFirstValid = true;
            }
        }

        try {
            var countRes = await fetch('/api/articolielaborati-count');
            var countData = await countRes.json();
            var serverCount = countData.count;
            if (serverCount !== undefined && serverCount !== null) {
                inFileCount = Number(serverCount) || 0;
            } else {
                inFileCount = 0;
            }
            var countEl = document.getElementById('articolielaborati-count');
            if (countEl) countEl.textContent = String(inFileCount);
        } catch (_) {
            inFileCount = 0;
        }
        updateProgressBar(articles.length, totalCompleted, inFileCount);
        await refreshNationSintesi();
        if (debugOne && testGotFirstValid) break;
    }

    if (stoppedByUser || abortElaboration) {
        logToConsole('STOP confermato: salto Fase 2B, sort, pipeline EMWA e sintesi finale.', 'warn');
        releaseAbortController(analyzeAbortController);
        analyzeAbortController = null;
        return;
    }

    // Dopo aver analizzato gli articoli principali, analizza anche eventuali link secondari (da Telegram) se Fase 2B attiva
    if (RUN_FASE_2B_LINK_SECONDARI) {
        await analyzeSecondaryLinks();
    } else {
        logToConsole('Fase 2B (elaborazione link secondari) sospesa. I link restano in link_secondari.json.', 'info');
    }

    // Ordina articolielaborati.json (Data crescente, poi importanza) PRIMA di qualunque sintesi
    try {
        await fetch('/api/articolielaborati-sort', { method: 'POST' });
        logToConsole('articolielaborati.json ordinato (dopo Fase 2B).', 'info');
    } catch (e) {
        logToConsole('Errore sort articolielaborati dopo Fase 2B: ' + e.message, 'warn');
    }

    // Avvia automaticamente la pipeline EMWA completa (EMWA_Pesato, EMWA_Pesato_Sommato, sintesi_EMWA_Pesato_Sommato e sintesi_EMWA_Pesato_Sommato_IA)
    logToConsole('Avvio pipeline EMWA (EMWA_Pesato, EMWA_Pesato_Sommato e sintesi IA)...', 'info');
    try {
        const emwaRes = await fetch('/api/elabora-articolielaborati', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const emwaData = await emwaRes.json();
        if (!emwaRes.ok || !emwaData.success) {
            logToConsole('Errore pipeline EMWA: ' + (emwaData && emwaData.error ? emwaData.error : ('HTTP ' + emwaRes.status)), 'error');
        } else {
            var emwaCount = Number(emwaData.count) || 0;
            logToConsole('Pipeline EMWA completata: ' + emwaCount + ' nazioni in sintesi_EMWA_Pesato_Sommato.json', emwaCount > 0 ? 'success' : 'info');
            if (logShowResponses && emwaData.ai_response) {
                logToConsole('[IA risposta question_EMWA_Pesato_Sommato] ' + previewResp(emwaData.ai_response), 'info');
            }
            // Aggiorna sintesi EMWA (mappe, liste) e sintesi IA pesata
            await refreshNationSintesi();
            await refreshNationSintesiIaPesata();
        }
    } catch (e) {
        logToConsole('Errore chiamata pipeline EMWA: ' + e.message, 'error');
    }

    logToConsole('Chiamata finale IA (validazione note + V_RED)...', 'info');
    try {
        const altRes = await fetch('/api/elabora-sintesi-alternativa', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const altData = await altRes.json();
        if (altData.success && altData.count != null) {
            logToConsole('Stima IA salvata: ' + altData.count + ' nazioni → sintesialternativa.json e note → note.json', 'success');
            logToConsole('Scritto sintesialternativa.json', 'info');
            logToConsole('Scritto note.json', 'info');
            logToConsole('Scritto sintesiVRED.json', 'info');
            // Log IA question_note (invio/risposta) in base ai check "Domanda" / "Risposta"
            if (logShowQuestions && altData.note_request) {
                var rqNote = String(altData.note_request);
                logToConsole('[IA invio question_note] ' + previewResp(rqNote), 'info');
            }
            if (logShowResponses && altData.note_response) {
                var rsNote = String(altData.note_response);
                logToConsole('[IA risposta question_note] ' + previewResp(rsNote), 'info');
            }
            if (logShowResponses && altData.emwa_response) {
                logToConsole('[IA risposta question_EMWA] ' + previewResp(altData.emwa_response), 'info');
            }
            await refreshNationSintesiAlternativa();
            await refreshNationEmwaIa();
            await refreshNationNote();
            await refreshNationAggregate();
            await refreshNationSintesi();
            await refreshNationSintesiV4();
            await refreshNationSintesiV5();
            await refreshNationSintesiElabIa();
            await refreshSintesiVRed();
            renderNationsListUnder365();
            if (map && typeof map.removeMarkers === 'function' && typeof map.addMarkers === 'function') {
                map.removeMarkers();
                map.addMarkers(getMarkersFromSintesi());
                applyRegionColorsFromSintesi();
                scheduleBubbleRebuild(150);
            }
            hideMapTooltips();
        } else if (altData.error) {
            logToConsole('Errore stima IA: ' + altData.error, 'error');
        }
    } catch (e) {
        logToConsole('Errore chiamata stima IA: ' + e.message, 'error');
    }

    if (debugOne) {
        logToConsole('--- Debug: fermato al primo articolo valido. FASE 2 conclusa. ---', 'success');
    }
    logToConsole('--- FASE 2 COMPLETATA ---', 'success');
    releaseAbortController(analyzeAbortController);
    analyzeAbortController = null;
}
}

// Fase 2B: analisi dei link secondari (es. link trovati nei post Telegram) usando la stessa IA degli articoli
async function analyzeSecondaryLinks() {
    try {
        const res = await fetch('/api/link-secondari');
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return;
        var links = data.filter(function (e) { return e && e.url; });
        if (links.length === 0) return;
        logToConsole('--- INIZIO FASE 2B: Analisi link secondari (Telegram, ecc.) ---', 'info');
        for (var i = 0; i < links.length; i++) {
            if (abortElaboration) {
                logToConsole('--- Fase 2B interrotta dall\'utente (STOP). ---', 'warn');
                break;
            }
            var linkObj = links[i];
            var url = String(linkObj.url || '').trim();
            if (!url) continue;
            var dateStr = linkObj.date != null ? String(linkObj.date).trim() : new Date().toISOString().substring(0, 10);
            var label = url.length > 120 ? url.substring(0, 120) + '...' : url;
            var linkType = detectUrlType(url);
            logToConsole('[Fase 2B] Analisi link secondario (' + getTypeLabel(linkType) + '): ' + label, 'info');
            try {
                const body = {
                    url: url,
                    title: label,
                    question: '',
                    article_date: dateStr,
                    type: linkType,
                    max_concurrent: getParallelAnalyzeLimit()
                };
                const aiRes = await fetch('/api/analyze-article', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const text = await aiRes.text();
                if (!aiRes.ok) {
                    logToConsole('[Fase 2B][AI ERROR] ' + label + ': HTTP ' + aiRes.status, 'error');
                    continue;
                }
                // La logica di salvataggio (articolielaborati, Accettati, Scartati) è tutta lato server in /api/analyze-article
                // quindi qui non serve altro che inviare la richiesta e loggare l'esito HTTP.
    } catch (e) {
                logToConsole('[Fase 2B][AI ERROR] ' + label + ': ' + (e && e.message ? e.message : ''), 'error');
            }
        }
        logToConsole('--- FASE 2B COMPLETATA (link secondari) ---', 'success');
    } catch (e) {
        logToConsole('Errore Fase 2B (link secondari): ' + e.message, 'error');
    }
}

// --- Map Initialization ---
let map;
let nationAggregate = { byCode: {}, byNation: {} };
let nationSintesi = { byCode: {}, byNation: {} };              // Sintesi ufficiale da sintesi_EMWA_Pesato_Sommato.json
let nationSintesiIa = { byCode: {}, byNation: {} };            // Sintesi IA da sintesi_EMWA_Pesato_Sommato_IA.json
let sintesiVRed = null;                                        // V_RED (messaggio globale)
let nationNote = { byCode: {}, byNation: {} };
let bubbleRebuildTimer = null;
let bubbleMoveRaf = null;
let isMapPointerDown = false;

// Codice ISO (minuscolo) -> nome nazione (italiano) per popup regioni senza dati
var ISO_CODE_TO_NAME = {
    af:'Afghanistan', al:'Albania', dz:'Algeria', ad:'Andorra', ao:'Angola', sa:'Arabia Saudita',
    ar:'Argentina', am:'Armenia', au:'Australia', at:'Austria', az:'Azerbaigian', bh:'Bahrein',
    bd:'Bangladesh', be:'Belgio', bz:'Belize', by:'Bielorussia', mm:'Birmania', bo:'Bolivia',
    ba:'Bosnia ed Erzegovina', bw:'Botswana', br:'Brasile', bg:'Bulgaria', bf:'Burkina Faso',
    bi:'Burundi', kh:'Cambogia', cm:'Camerun', ca:'Canada', cv:'Capo Verde', td:'Ciad',
    cl:'Cile', cn:'Cina', cy:'Cipro', co:'Colombia', kp:'Corea del Nord', kr:'Corea del Sud',
    ci:"Costa d'Avorio", cr:'Costa Rica', hr:'Croazia', cu:'Cuba', dk:'Danimarca', ec:'Ecuador',
    eg:'Egitto', ae:'Emirati Arabi Uniti', er:'Eritrea', ee:'Estonia', et:'Etiopia', ph:'Filippine',
    fi:'Finlandia', fr:'Francia', ga:'Gabon', gm:'Gambia', ge:'Georgia', de:'Germania', gh:'Ghana',
    jp:'Giappone', dj:'Gibuti', jo:'Giordania', gr:'Grecia', gt:'Guatemala', gn:'Guinea',
    gw:'Guinea-Bissau', gq:'Guinea Equatoriale', ht:'Haiti', hn:'Honduras', in:'India',
    id:'Indonesia', ir:'Iran', iq:'Iraq', ie:'Irlanda', is:'Islanda', il:'Israele', it:'Italia',
    kz:'Kazakistan', ke:'Kenya', kg:'Kirghizistan', xk:'Kosovo', kw:'Kuwait', la:'Laos',
    lv:'Lettonia', lb:'Libano', lr:'Liberia', ly:'Libia', li:'Liechtenstein', lt:'Lituania',
    lu:'Lussemburgo', mk:'Macedonia del Nord', mg:'Madagascar', mw:'Malawi', my:'Malesia',
    mv:'Maldive', ml:'Mali', mt:'Malta', ma:'Marocco', mr:'Mauritania', mu:'Mauritius',
    mx:'Messico', md:'Moldavia', mn:'Mongolia', me:'Montenegro', mz:'Mozambico', na:'Namibia',
    np:'Nepal', ni:'Nicaragua', ne:'Niger', ng:'Nigeria', no:'Norvegia', nz:'Nuova Zelanda',
    om:'Oman', nl:'Paesi Bassi', pk:'Pakistan', ps:'Palestina', pa:'Panama', pg:'Papua Nuova Guinea',
    py:'Paraguay', pe:'Perù', pl:'Polonia', pt:'Portogallo', qa:'Qatar', gb:'Regno Unito',
    cz:'Repubblica Ceca', cd:'Repubblica Democratica del Congo', cg:'Repubblica del Congo',
    ro:'Romania', ru:'Russia', rw:'Ruanda', sn:'Senegal', rs:'Serbia', sl:'Sierra Leone',
    sg:'Singapore', sy:'Siria', sk:'Slovacchia', si:'Slovenia', so:'Somalia', es:'Spagna',
    lk:'Sri Lanka', us:'Stati Uniti', za:'Sudafrica', sd:'Sudan', ss:'Sudan del Sud',
    se:'Svezia', ch:'Svizzera', sz:'Swaziland', tj:'Tagikistan', tw:'Taiwan', tz:'Tanzania',
    th:'Thailandia', tl:'Timor Est', tg:'Togo', tt:'Trinidad e Tobago', tn:'Tunisia',
    tr:'Turchia', tm:'Turkmenistan', ua:'Ucraina', ug:'Uganda', hu:'Ungheria', uy:'Uruguay',
    uz:'Uzbekistan', ve:'Venezuela', vn:'Vietnam', ye:'Yemen', zm:'Zambia', zw:'Zimbabwe'
};

// Coordinate approssimative (centro nazione) per segnaposto su mappa [lat, lng]
var COUNTRY_COORDS = {
    af: [33.9, 67.7], al: [41.2, 20.2], dz: [28.0, 2.0], ad: [42.5, 1.5], ao: [-12.3, 17.5],
    sa: [24.0, 45.0], ar: [-34.6, -58.4], am: [40.1, 44.5], au: [-25.3, 133.8], at: [47.5, 14.5],
    az: [40.1, 47.6], bh: [26.1, 50.6], bd: [23.7, 90.4], be: [50.5, 4.5], bz: [17.2, -88.8],
    by: [53.7, 27.9], mm: [21.9, 95.9], bo: [-16.5, -68.1], ba: [43.9, 18.4], bw: [-22.3, 24.7],
    br: [-14.2, -51.9], bg: [42.7, 25.5], bf: [12.2, -1.6], bi: [-3.4, 29.9], kh: [12.6, 104.9],
    cm: [6.4, 12.4], ca: [56.1, -106.3], cv: [15.1, -23.6], td: [15.5, 19.0], cl: [-35.7, -71.5],
    cn: [35.9, 104.2], cy: [35.1, 33.4], co: [4.6, -74.1], kp: [40.3, 127.5], kr: [35.9, 127.8],
    ci: [7.5, -5.5], cr: [9.7, -83.8], hr: [45.1, 15.2], cu: [21.5, -78.0], dk: [56.3, 9.5],
    ec: [-1.8, -78.2], eg: [26.8, 30.8], ae: [24.0, 54.0], er: [15.2, 39.8], ee: [58.6, 25.0],
    et: [9.0, 40.5], ph: [12.9, 121.8], fi: [64.0, 26.0], fr: [46.2, 2.2], ga: [-0.8, 11.6],
    gm: [13.4, -15.3], ge: [42.3, 43.4], de: [51.2, 10.5], gh: [7.9, -1.0], jp: [36.2, 138.3],
    dj: [11.8, 42.6], jo: [31.9, 36.3], gr: [39.1, 21.8], gt: [15.8, -90.2], gn: [9.9, -9.7],
    gw: [12.0, -15.0], gq: [1.7, 10.3], ht: [18.9, -72.3], hn: [15.2, -86.2], in: [20.6, 78.9],
    id: [-0.8, 113.9], ir: [32.4, 53.7], iq: [33.2, 43.7], ie: [53.4, -7.9], is: [64.9, -19.0],
    il: [31.5, 34.8], it: [41.9, 12.6], kz: [48.0, 68.0], ke: [-0.0, 37.9], kg: [41.2, 74.8],
    xk: [42.6, 20.9], kw: [29.3, 47.5], la: [19.9, 102.1], lv: [56.9, 24.6], lb: [33.9, 35.9],
    lr: [6.4, -9.5], ly: [27.0, 17.0], li: [47.2, 9.5], lt: [55.2, 23.9], lu: [49.8, 6.1],
    mk: [41.6, 21.7], mg: [-18.8, 46.9], mw: [-13.3, 34.3], my: [4.2, 101.9], mv: [3.2, 73.2],
    ml: [17.6, -4.0], mt: [35.9, 14.5], ma: [31.8, -7.1], mr: [21.0, -11.0], mu: [-20.3, 57.6],
    mx: [23.6, -102.5], md: [47.4, 28.4], mn: [46.9, 103.8], me: [42.7, 19.4], mz: [-18.7, 35.5],
    na: [-22.9, 18.5], np: [28.4, 84.1], ni: [12.9, -85.2], ne: [17.6, 8.1], ng: [9.1, 8.7],
    no: [60.5, 8.5], nz: [-40.9, 174.9], om: [21.5, 55.9], nl: [52.1, 5.3], pk: [30.4, 69.3],
    ps: [31.9, 35.2], pa: [8.5, -80.8], pg: [-6.3, 143.9], py: [-23.4, -58.4], pe: [-9.2, -75.0],
    pl: [51.9, 19.1], pt: [39.4, -8.2], qa: [25.3, 51.5], gb: [54.6, -2.4], cz: [49.8, 15.5],
    cd: [-4.0, 21.8], cg: [-0.7, 15.9], ro: [45.9, 24.9], ru: [61.5, 105.3], rw: [-2.0, 29.9],
    sn: [14.5, -14.5], rs: [44.0, 21.0], sl: [8.5, -11.8], sg: [1.4, 103.8], sy: [35.0, 38.5],
    sk: [48.7, 19.7], si: [46.2, 14.8], so: [6.0, 46.2], es: [40.5, -3.7], lk: [7.9, 80.8],
    us: [38.0, -97.0], za: [-30.6, 22.9], sd: [15.5, 32.5], ss: [6.9, 30.6], se: [62.2, 17.6],
    ch: [46.8, 8.2], sz: [-26.5, 31.5], tj: [38.9, 71.3], tw: [23.7, 121.0], tz: [-6.4, 34.9],
    th: [15.9, 100.9], tl: [-8.8, 125.7], tg: [8.6, 0.8], tt: [10.7, -61.2], tn: [34.0, 9.5],
    tr: [39.1, 35.2], tm: [39.0, 59.6], ua: [48.4, 31.2], ug: [1.4, 32.3], hu: [47.2, 19.5],
    uy: [-32.5, -55.8], uz: [41.4, 64.6], ve: [6.4, -66.6], vn: [14.1, 108.3], ye: [15.6, 48.5],
    zm: [-13.1, 27.8], zw: [-19.0, 29.2]
};

// Colore bubble in base a giorni (min tra GG e GR): rosso ≤7, arancio ≤30, giallo ≤60, lime ≤90, verde >90
function colorFromMetric(val) {
    var n = parseInt(val, 10);
    if (isNaN(n)) return '#6b7280'; // grigio se assente
    if (n <= 7) return '#ef4444';  // rosso – fino a 7 giorni
    if (n <= 30) return '#f59e0b'; // arancio – fino a 30 giorni
    if (n <= 60) return '#eab308'; // giallo – fino a 60 giorni
    if (n <= 90) return '#84cc16'; // lime – fino a 90 giorni
    return '#22c55e';              // verde – oltre 90 giorni
}

// Stessa scala di colorFromMetric ma tenui per il fill delle regioni sulla mappa (in stile con sfondo scuro)
function colorFromMetricMuted(val) {
    var n = parseInt(val, 10);
    if (isNaN(n)) return '#404040'; // grigio tenue
    if (n <= 7) return '#6b4040';   // rosso tenue
    if (n <= 30) return '#6b5230';  // arancio tenue
    if (n <= 60) return '#5c5428';  // giallo tenue
    if (n <= 90) return '#4a5c2a';  // lime tenue
    return '#2d4a38';               // verde tenue
}

// Fumetti, popup (solo GG/GR < 365), lista G/N < 365 usano i GG/GR della sintesi IA (nationSintesiIa) se disponibili; in assenza, ricadono su sintesi_EMWA_Pesato_Sommato.json (nationSintesi)
function getMarkersFromSintesi() {
    var out = [];
    var byCodeBase = nationSintesi.byCode || {};
    var byCodeIa = nationSintesiIa.byCode || {};
    for (var code in byCodeBase) {
        if (!byCodeBase.hasOwnProperty(code)) continue;
        var baseInfo = byCodeBase[code];
        var iaInfo = byCodeIa[code];
        var coords = COUNTRY_COORDS[code.toLowerCase()];
        if (!coords) continue;
        // Scegli GG/GR dalla sintesi IA se presenti, altrimenti dalla sintesi base
        var ggSrc = iaInfo && (iaInfo.gg != null || iaInfo.GG != null)
            ? (iaInfo.gg != null ? iaInfo.gg : iaInfo.GG)
            : (baseInfo && (baseInfo.gg != null || baseInfo.GG != null)
                ? (baseInfo.gg != null ? baseInfo.gg : baseInfo.GG)
                : '');
        var grSrc = iaInfo && (iaInfo.gr != null || iaInfo.GR != null)
            ? (iaInfo.gr != null ? iaInfo.gr : iaInfo.GR)
            : (baseInfo && (baseInfo.gr != null || baseInfo.GR != null)
                ? (baseInfo.gr != null ? baseInfo.gr : baseInfo.GR)
                : '');
        var gg = ggSrc !== '' && ggSrc != null ? String(ggSrc).trim() : '';
        var gr = grSrc !== '' && grSrc != null ? String(grSrc).trim() : '';
        var ggNum = parseInt(gg, 10);
        var grNum = parseInt(gr, 10);
        var hasRelevantMetric = (!isNaN(ggNum) && ggNum < 365) || (!isNaN(grNum) && grNum < 365);
        if (!hasRelevantMetric) continue;
        var minDays = NaN;
        if (!isNaN(ggNum) && !isNaN(grNum)) minDays = Math.min(ggNum, grNum);
        else if (!isNaN(ggNum)) minDays = ggNum;
        else if (!isNaN(grNum)) minDays = grNum;
        var bubbleColor = colorFromMetric(isNaN(minDays) ? '' : String(minDays));
        var nazione = ((iaInfo && iaInfo.nazione) || (baseInfo && baseInfo.nazione) || '').trim() ||
            (nationSintesi.byCode && nationSintesi.byCode[code] && nationSintesi.byCode[code].nazione) || code;
        // Per l'etichetta usa gli stessi GG/GR scelti sopra
        var labelInfo = { nazione: nazione, gg: gg, gr: gr };
        out.push({
            name: formatSintesiLabel(labelInfo),
            coords: coords,
            nazione: nazione,
            gg: gg,
            gr: gr,
            bubbleColor: bubbleColor,
            style: {
                initial: {
                    fill: bubbleColor,
                    stroke: '#1f2937',
                    strokeWidth: 1,
                    r: 5
                },
                hover: { fill: bubbleColor, r: 6 },
                selected: { fill: bubbleColor }
            }
        });
    }
    return out;
}

// Oggetto codice nazione (minuscolo) -> colore fill regione mappa (tenue, in stile con la pagina)
// Usa gli stessi GG/GR della sintesi IA dei pallini (nationSintesiIa) se disponibili; in assenza ricade sui valori base (nationSintesi)
function getRegionColorsFromSintesi() {
    var colors = {};
    var byCodeBase = nationSintesi.byCode || {};
    var byCodeIa = nationSintesiIa.byCode || {};
    for (var code in byCodeBase) {
        if (!byCodeBase.hasOwnProperty(code)) continue;
        var baseInfo = byCodeBase[code];
        var iaInfo = byCodeIa[code];
        var ggSrc = iaInfo && (iaInfo.gg != null || iaInfo.GG != null)
            ? (iaInfo.gg != null ? iaInfo.gg : iaInfo.GG)
            : (baseInfo && (baseInfo.gg != null || baseInfo.GG != null)
                ? (baseInfo.gg != null ? baseInfo.gg : baseInfo.GG)
                : '');
        var grSrc = iaInfo && (iaInfo.gr != null || iaInfo.GR != null)
            ? (iaInfo.gr != null ? iaInfo.gr : iaInfo.GR)
            : (baseInfo && (baseInfo.gr != null || baseInfo.GR != null)
                ? (baseInfo.gr != null ? baseInfo.gr : baseInfo.GR)
                : '');
        var gg = ggSrc !== '' && ggSrc != null ? String(ggSrc).trim() : '';
        var gr = grSrc !== '' && grSrc != null ? String(grSrc).trim() : '';
        var ggNum = parseInt(gg, 10);
        var grNum = parseInt(gr, 10);
        var hasRelevantMetric = (!isNaN(ggNum) && ggNum < 365) || (!isNaN(grNum) && grNum < 365);
        if (!hasRelevantMetric) continue;
        var minDays = NaN;
        if (!isNaN(ggNum) && !isNaN(grNum)) minDays = Math.min(ggNum, grNum);
        else if (!isNaN(ggNum)) minDays = ggNum;
        else if (!isNaN(grNum)) minDays = grNum;
        var regionColor = colorFromMetricMuted(isNaN(minDays) ? '' : String(minDays));
        var key = (code || '').toLowerCase();
        if (key) colors[key] = regionColor;
    }
    return colors;
}

// Applica alle regioni della mappa i colori del pallino (fill della nazione = colore del bubble)
function applyRegionColorsFromSintesi() {
    var container = document.getElementById('world-map');
    if (!container) return;
    var svg = container.querySelector('svg');
    if (!svg) return;
    var colors = getRegionColorsFromSintesi();
    var defaultFill = '#2a2a2a';
    svg.querySelectorAll('path').forEach(function (path) {
        var code = (path.getAttribute('data-code') || '').trim().toLowerCase();
        if (!code) {
            var id = (path.getAttribute('id') || '').trim();
            if (id.indexOf('jvm-region-') === 0) code = id.replace(/^jvm-region-/i, '').toLowerCase();
            else if (id && id.length === 2) code = id.toLowerCase();
        }
        if (!code) return;
        var fill = colors[code] || defaultFill;
        path.style.fill = fill;
    });
}

async function refreshNationAggregate() {
    try {
        const res = await fetch('/api/nazioni-aggregate');
        const data = await res.json();
        nationAggregate.byCode = data.byCode || {};
        nationAggregate.byNation = data.byNation || {};
    } catch (e) { /* ignora */ }
}

function hideMapTooltips() {
    document.querySelectorAll('.jvm-tooltip').forEach(function (el) {
        el.style.display = 'none';
        el.style.opacity = '0';
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
    });
}

async function refreshNationSintesi() {
    try {
        const res = await fetch('/api/nazioni-sintesi');
        const data = await res.json();
        nationSintesi.byCode = data.byCode || {};
        nationSintesi.byNation = data.byNation || {};
        hideMapTooltips();
        renderNationsListUnder365();
        if (map && typeof map.removeMarkers === 'function' && typeof map.addMarkers === 'function') {
            map.removeMarkers();
            map.addMarkers(getMarkersFromSintesi());
            applyRegionColorsFromSintesi();
            scheduleBubbleRebuild(150);
        }
        if (map && typeof map.updateSize === 'function') map.updateSize();
    } catch (e) { /* ignora */ }
}

async function refreshNationSintesiIaPesata() {
    try {
        const res = await fetch('/api/sintesi-emwa-pesato-ia');
        const data = await res.json();
        nationSintesiIa.byCode = data.byCode || {};
        nationSintesiIa.byNation = data.byNation || {};
    } catch (e) { /* ignora */ }
}

async function refreshNationSintesiAlternativa() {
    try {
        const res = await fetch('/api/nazioni-sintesi-alternativa');
        const data = await res.json();
        // Manteniamo la chiamata per compatibilità, ma non usiamo più questi dati per GG/GR
        hideMapTooltips();
    } catch (e) { /* ignora */ }
}

async function refreshNationEmwaIa() {
    try {
        const res = await fetch('/api/nazioni-emwa-ia');
        const data = await res.json();
        // Endpoint disabilitato: nessun uso per GG/GR
        hideMapTooltips();
    } catch (e) { /* ignora */ }
}

async function refreshNationNote() {
    try {
        const res = await fetch('/api/nazioni-note');
        const data = await res.json();
        nationNote.byCode = data.byCode || {};
        nationNote.byNation = data.byNation || {};
        hideMapTooltips();
    } catch (e) { /* ignora */ }
}

async function refreshNationSintesiV4() {
    try {
        const res = await fetch('/api/nazioni-sintesi-v4');
        const data = await res.json();
        // Endpoint disabilitato: nessun uso per GG/GR
        hideMapTooltips();
        renderNationsListUnder365();
        if (map && typeof map.removeMarkers === 'function' && typeof map.addMarkers === 'function') {
            map.removeMarkers();
            map.addMarkers(getMarkersFromSintesi());
            applyRegionColorsFromSintesi();
            scheduleBubbleRebuild(150);
        }
        if (map && typeof map.updateSize === 'function') map.updateSize();
    } catch (e) { /* ignora */ }
}

async function refreshNationSintesiV5() {
    try {
        const res = await fetch('/api/nazioni-sintesi-v5');
        const data = await res.json();
        // Endpoint disabilitato: nessun uso per GG/GR
        hideMapTooltips();
        renderNationsListUnder365();
        if (map && typeof map.removeMarkers === 'function' && typeof map.addMarkers === 'function') {
            map.removeMarkers();
            map.addMarkers(getMarkersFromSintesi());
            applyRegionColorsFromSintesi();
            scheduleBubbleRebuild(150);
        }
        if (map && typeof map.updateSize === 'function') map.updateSize();
    } catch (e) { /* ignora */ }
}

async function refreshNationSintesiElabIa() {
    // V6 disabilitato: funzione mantenuta solo per compatibilità, non fa nulla.
}

// Sintesi V_RED (messaggio globale di rischio): aggiorna pannello "Avviso urgente"
async function refreshSintesiVRed() {
    try {
        const res = await fetch('/api/sintesi-vred');
        const data = await res.json();
        var panel = document.getElementById('urgent-panel');
        var msgEl = document.getElementById('urgent-message');
        var daysEl = document.getElementById('urgent-days');
        var pctEl = document.getElementById('urgent-percentage');
        var popupEl = document.getElementById('urgent-spiegazione-popup');
        if (!panel || !msgEl || !daysEl) return;
        var msg = (data && (data.Messaggio != null && data.Messaggio !== '')) ? String(data.Messaggio).trim() : '';
        var days = (data && (data.Giorni != null && data.Giorni !== '')) ? String(data.Giorni).trim() : '';
        var pct = (data && data.PercentualeCertezza != null) ? data.PercentualeCertezza : (data && data['Percentuale di certezza'] != null ? data['Percentuale di certezza'] : null);
        if (typeof pct !== 'number') {
            var n = parseInt(String(pct || '').trim(), 10);
            pct = (isFinite(n) && n >= 0 && n <= 100) ? n : null;
        } else if (pct < 0 || pct > 100) pct = null;
        var spiegazione = (data && data.Spiegazione != null && String(data.Spiegazione).trim() !== '') ? String(data.Spiegazione).trim() : '';
        var promptFeedback = (data && data.Prompt != null && String(data.Prompt).trim() !== '') ? String(data.Prompt).trim() : '';
        if (popupEl) {
            var hasExpl = !!spiegazione;
            var hasPrompt = !!promptFeedback;
            if (hasExpl || hasPrompt) {
                var html = '';
                if (hasExpl) {
                    html += '<div class="urgent-expl-block">' + escapeHtml(spiegazione) + '</div>';
                }
                if (hasPrompt) {
                    html += '<div class="urgent-expl-block"><strong>Suggerimenti sul prompt:</strong><br>' + escapeHtml(promptFeedback) + '</div>';
                }
                popupEl.innerHTML = html;
            } else {
                popupEl.textContent = 'Nessuna spiegazione disponibile.';
            }
            popupEl.classList.remove('is-visible');
        }
        if (msg) {
            msgEl.textContent = msg;
            var daysPart = days ? ('Giorni: ' + escapeHtml(String(days))) : '';
            var pctPart = (pct != null) ? ('<span class="urgent-pct-inline">' + String(pct) + '% certezza</span>') : '';
            daysEl.innerHTML = [daysPart, pctPart].filter(Boolean).join(' — ');
            if (pctEl) pctEl.textContent = '';
        } else {
            msgEl.textContent = 'Nessun avviso globale disponibile.';
            daysEl.textContent = '';
            if (pctEl) pctEl.textContent = '';
        }
        panel.style.display = '';
    } catch (e) { /* ignora */ }
}

function initUrgentInfoButton() {
    var infoBtn = document.getElementById('urgent-info-btn');
    var popupEl = document.getElementById('urgent-spiegazione-popup');
    if (!infoBtn || !popupEl) return;
    infoBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        popupEl.classList.toggle('is-visible');
    });
    document.addEventListener('click', function () {
        popupEl.classList.remove('is-visible');
    });
    popupEl.addEventListener('click', function (e) {
        e.stopPropagation();
    });
}

function initUrgentRegeneraButton() {
    var btn = document.getElementById('urgent-regenera-btn');
    if (!btn) return;
    btn.addEventListener('click', async function () {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
            logToConsole('Rigenerazione sintesi VRED in corso...', 'info');
            var res = await fetch('/api/rigenera-sintesi-vred', { method: 'POST' });
            var data = await res.json();
            if (data && data.ok) {
                await refreshSintesiVRed();
                logToConsole('Sintesi VRED rigenerata.', 'success');
            } else {
                var errMsg = (data && data.error ? data.error : res.status);
                logToConsole('Errore rigenera VRED: ' + errMsg, 'error');
                // Se il backend segnala risposta vuota/non parsabile, manteniamo esplicitamente il messaggio precedente
                if (typeof errMsg === 'string' && (errMsg.indexOf('Risposta IA vuota') !== -1 || errMsg.indexOf('non parsabile') !== -1)) {
                    logToConsole('VRED non aggiornato: mantengo l\'ultimo messaggio valido già presente in sintesiVRED.json.', 'warn');
                }
                await refreshSintesiVRed();
            }
        } catch (e) {
            logToConsole('Errore rigenera VRED: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

// Guerra: mostra solo nazioni con GG < 365 (giorni alla guerra), ordinate per GG crescente.
// Nucleare: mostra solo nazioni con GR < 15 (giorni al nucleare), ordinate per GR crescente — usa i GG/GR della sintesi IA (nationSintesiIa) se disponibili; altrimenti ricade sulla sintesi base (nationSintesi)
var NATIONS_LIST_THRESHOLD = 365;

function getNationsGuerra() {
    var list = [];
    var byNationBase = nationSintesi.byNation || {};
    var byNationIa = nationSintesiIa.byNation || {};
    for (var name in byNationBase) {
        if (!byNationBase.hasOwnProperty(name)) continue;
        var iaInfo = byNationIa[name];
        var baseInfo = byNationBase[name];
        var ggSrc = iaInfo && (iaInfo.gg != null || iaInfo.GG != null)
            ? (iaInfo.gg != null ? iaInfo.gg : iaInfo.GG)
            : (baseInfo && (baseInfo.gg != null || baseInfo.GG != null)
                ? (baseInfo.gg != null ? baseInfo.gg : baseInfo.GG)
                : '');
        var ggNum = ggSrc !== '' && ggSrc != null ? parseInt(String(ggSrc).trim(), 10) : NaN;
        // Mostra solo nazioni con GG < 365
        if (!isNaN(ggNum) && ggNum < NATIONS_LIST_THRESHOLD)
            list.push({ nazione: name, ggNum: ggNum });
    }
    // Ordine crescente: prima le nazioni con GG più basso (più urgenti)
    list.sort(function (a, b) { return a.ggNum - b.ggNum; });
    return list;
}

function getNationsNucleare() {
    var list = [];
    var byNationBase = nationSintesi.byNation || {};
    var byNationIa = nationSintesiIa.byNation || {};
    for (var name in byNationBase) {
        if (!byNationBase.hasOwnProperty(name)) continue;
        var iaInfo = byNationIa[name];
        var baseInfo = byNationBase[name];
        var grSrc = iaInfo && (iaInfo.gr != null || iaInfo.GR != null)
            ? (iaInfo.gr != null ? iaInfo.gr : iaInfo.GR)
            : (baseInfo && (baseInfo.gr != null || baseInfo.GR != null)
                ? (baseInfo.gr != null ? baseInfo.gr : baseInfo.GR)
                : '');
        var grNum = grSrc !== '' && grSrc != null ? parseInt(String(grSrc).trim(), 10) : NaN;
        if (!isNaN(grNum) && grNum < 15)
            list.push({ nazione: name, grNum: grNum });
    }
    // Ordine inverso rispetto a prima: in alto i GR più bassi (più urgenti)
    list.sort(function (a, b) { return a.grNum - b.grNum; });
    return list;
}

function renderNationsListGuerra() {
    var container = document.getElementById('nations-list-guerra');
    if (!container) return;
    var list = getNationsGuerra();
    container.innerHTML = '';
    var cap = NATIONS_LIST_THRESHOLD;
    list.forEach(function (item) {
        var ggNum = item.ggNum;
        var invGG = (typeof ggNum === 'number' && !isNaN(ggNum) && ggNum < cap) ? Math.max(0, cap - ggNum) / cap * 100 : 0;
        var colorGG = colorFromMetric(typeof ggNum === 'number' && !isNaN(ggNum) ? String(ggNum) : '');
        var ggDisp = typeof ggNum === 'number' && !isNaN(ggNum) ? ggNum : '–';
        var div = document.createElement('div');
        div.className = 'nation-list-item';
        div.innerHTML =
            '<div class="nation-list-name">' + escapeHtml(item.nazione) + ' <span class="nation-list-values">' + escapeHtml(displayMetric(ggDisp)) + ' gg</span></div>' +
            '<div class="nation-list-bar-wrap"><div class="nation-list-bar-track"><div class="nation-list-bar" style="width:' + invGG + '%;background:' + colorGG + '" title="Giorni alla Guerra: ' + escapeHtml(displayMetric(ggDisp)) + '"></div></div></div>';
        container.appendChild(div);
    });
}

function renderNationsListNucleare() {
    var container = document.getElementById('nations-list-nucleare');
    if (!container) return;
    var list = getNationsNucleare();
    container.innerHTML = '';
    var cap = NATIONS_LIST_THRESHOLD;
    list.forEach(function (item) {
        var grNum = item.grNum;
        var invGR = (typeof grNum === 'number' && !isNaN(grNum) && grNum < cap) ? Math.max(0, cap - grNum) / cap * 100 : 0;
        var colorGR = colorFromMetric(typeof grNum === 'number' && !isNaN(grNum) ? String(grNum) : '');
        var grDisp = typeof grNum === 'number' && !isNaN(grNum) ? grNum : '–';
        var div = document.createElement('div');
        div.className = 'nation-list-item';
        div.innerHTML =
            '<div class="nation-list-name">' + escapeHtml(item.nazione) + ' <span class="nation-list-values">' + escapeHtml(displayMetric(grDisp)) + ' gg</span></div>' +
            '<div class="nation-list-bar-wrap"><div class="nation-list-bar-track"><div class="nation-list-bar" style="width:' + invGR + '%;background:' + colorGR + '" title="Giorni al Nucleare: ' + escapeHtml(displayMetric(grDisp)) + '"></div></div></div>';
        container.appendChild(div);
    });
}

function renderNationsListUnder365() {
    renderNationsListNucleare();
    renderNationsListGuerra();
}

async function updateArticolielaboratiCountDisplay() {
    var el = document.getElementById('articolielaborati-count');
    try {
        var res = await fetch('/api/articolielaborati-count');
        var data = await res.json();
        var n = data.count != null ? data.count : 0;
        if (el) el.textContent = n;
        updateProgressBar(null, null, typeof n === 'number' ? n : 0);
    } catch (e) {
        if (el) el.textContent = '-';
        updateProgressBar(null, null, 0);
    }
}

function parseArticleDateValue(v) {
    if (!v) return null;
    var d = new Date(String(v).trim());
    if (isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
}

function formatDateItDayMonth(d) {
    if (!d || isNaN(d.getTime())) return '';
    var months = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
    return d.getDate() + ' ' + months[d.getMonth()];
}

var lastArticlesDateRangeLabel = '';

async function refreshArticlesDateRangeLabel() {
    var el = document.getElementById('articles-date-range');
    if (!el) return;
    try {
        var lookback = typeof emwaLookbackHours === 'number' ? emwaLookbackHours : 168;
        var res = await fetch('/api/status-ai?emwa_lookback_hours=' + encodeURIComponent(lookback));
        var data = await res.json();
        var arr = [];
        // Per compatibilità futura, se il server restituisce direttamente un array,
        // calcola comunque min/max dalla lista. Oggi usiamo status-ai con campi dedicati.
        if (Array.isArray(data)) {
            arr = data;
        }
        var minD = null;
        var maxD = null;
        // Preferisci min/max dedicati da /api/status-ai se presenti
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            if (data.riassuntoMinDate) {
                var dMin = parseArticleDateValue(data.riassuntoMinDate);
                if (dMin) minD = dMin;
            }
            if (data.riassuntoMaxDate) {
                var dMax = parseArticleDateValue(data.riassuntoMaxDate);
                if (dMax) maxD = dMax;
            }
        }
        // Fallback: calcolo da array (solo se non abbiamo trovato min/max sopra)
        if ((!minD || !maxD) && arr.length) {
            for (var i = 0; i < arr.length; i++) {
                var a = arr[i] || {};
                var d = parseArticleDateValue(a.Data || a.date || a.data || a.article_date || '');
                if (!d) continue;
                if (!minD || d < minD) minD = d;
                if (!maxD || d > maxD) maxD = d;
            }
        }
        var parts = [];
        if (minD && maxD) {
            parts.push(formatDateItDayMonth(minD) + ' • ' + formatDateItDayMonth(maxD));
        }
        var label = parts.join(' — ');
        // Aggiorna il DOM solo se la label è cambiata, per ridurre sfarfallii
        if (label !== lastArticlesDateRangeLabel) {
            lastArticlesDateRangeLabel = label;
            el.textContent = label;
        }
        // Articoli in riassunto (inviati alla chat, in base al tempo di retroelaborazione)
        var countEl = document.getElementById('riassunto-chat-count');
        if (countEl && data && typeof data.riassuntoCount === 'number') {
            countEl.textContent = 'Articoli : ' + data.riassuntoCount;
        } else if (countEl) {
            countEl.textContent = '';
        }
    } catch (_) {
        lastArticlesDateRangeLabel = '';
        el.textContent = '';
        var countEl = document.getElementById('riassunto-chat-count');
        if (countEl) countEl.textContent = '';
    }
}

function setProgressPhase(phase, meta) {
    progressState.phase = phase || 'idle';
    if (meta && typeof meta === 'object') {
        if (meta.urlsTotal !== undefined && meta.urlsTotal !== null) progressState.urlsTotal = meta.urlsTotal;
        if (meta.urlsExamined !== undefined && meta.urlsExamined !== null) progressState.urlsExamined = meta.urlsExamined;
        if (meta.accepted !== undefined && meta.accepted !== null) progressState.accepted = meta.accepted;
        if (meta.acceptedTotal !== undefined && meta.acceptedTotal !== null) progressState.acceptedTotal = meta.acceptedTotal;
        if (meta.pertinenti !== undefined && meta.pertinenti !== null) progressState.pertinenti = meta.pertinenti;
        if (meta.pertinentiTotal !== undefined && meta.pertinentiTotal !== null) progressState.pertinentiTotal = meta.pertinentiTotal;
    }
}

function updateProgressBar(total, elaborated, inFile) {
    var fillEl = document.getElementById('progress-bar-fill');
    var textEl = document.getElementById('progress-text');
    if (!fillEl || !textEl) return;
    if (total !== undefined && total !== null) progressState.total = total;
    if (elaborated !== undefined && elaborated !== null) progressState.elaborated = elaborated;
    if (inFile !== undefined && inFile !== null) progressState.inFile = inFile;
    var t = progressState.total;
    var e = progressState.elaborated;
    var f = progressState.inFile;
    var pct = (t > 0 && e >= 0) ? Math.round((e / t) * 100) : 0;
    fillEl.style.width = pct + '%';
    var phase = progressState.phase || 'idle';
    if (phase === 'urls') {
        var ue = Number(progressState.urlsExamined) || 0;
        var ut = Number(progressState.urlsTotal) || 0;
        textEl.textContent = 'URL esaminati: ' + ue + ' / ' + ut;
        return;
    }
    if (phase === 'raccolta') {
        var aa = Number(progressState.accepted) || 0;
        var at = Number(progressState.acceptedTotal) || 0;
        textEl.textContent = 'Articoli accettati: ' + aa + ' / ' + at;
        return;
    }
    if (phase === 'fase1b') {
        var pp = Number(progressState.pertinenti) || 0;
        var pt = Number(progressState.pertinentiTotal) || 0;
        textEl.textContent = 'Articoli pertinenti: ' + pp + ' / ' + pt;
        return;
    }
    if (phase === 'fase2') {
        textEl.textContent = 'Articoli elaborati: ' + e + ' / ' + t + ' — In file: ' + f;
        return;
    }
    textEl.textContent = 'Elaborati: ' + e + ' / ' + t + ' — Inseriti in file: ' + f;
}
var progressState = {
    total: 0,
    elaborated: 0,
    inFile: 0,
    phase: 'idle',
    urlsExamined: 0,
    urlsTotal: 0,
    accepted: 0,
    acceptedTotal: 0,
    pertinenti: 0,
    pertinentiTotal: 0
};

var activeAgentsCount = 0;

function updateActiveAgentsUI() {
    var el = document.getElementById('active-agents-text');
    if (!el) return;
    var max = 1;
    try {
        max = getParallelAnalyzeLimit();
    } catch (_) {}
    el.textContent = 'Agenti attivi: ' + activeAgentsCount + ' / ' + max;
}

function incrementActiveAgents() {
    activeAgentsCount++;
    updateActiveAgentsUI();
}

function decrementActiveAgents() {
    if (activeAgentsCount > 0) activeAgentsCount--;
    updateActiveAgentsUI();
}

function resetActiveAgents() {
    activeAgentsCount = 0;
    updateActiveAgentsUI();
}

var nextAutoElaboraThreshold = 50;
var elaboraRunning = false;

function setElaboraButtonsRunning(running) {
    elaboraRunning = !!running;
    var btnSintesiNazioni = document.querySelector('button[onclick="elaboraPesatiERiassunto()"]');
    var btnSintesiPesata = document.querySelector('button[onclick="elaboraSintesiPesata()"]');
    var btnNote = document.querySelector('button[onclick="generaNote()"]');
    var btnVRed = document.querySelector('button[onclick="generaVRed()"]');
    if (btnSintesiNazioni) {
        btnSintesiNazioni.disabled = running;
        btnSintesiNazioni.textContent = running ? 'Pesati + Riassunto…' : 'Pesati + Riassunto';
    }
    if (btnSintesiPesata) {
        btnSintesiPesata.disabled = running;
        btnSintesiPesata.textContent = running ? 'Sintesi…' : 'Sintesi';
    }
    if (btnNote) {
        btnNote.disabled = running;
        btnNote.textContent = running ? 'Note…' : 'Note';
    }
    if (btnVRed) {
        btnVRed.disabled = running;
        btnVRed.textContent = running ? 'VRed…' : 'VRed';
    }
}

function refreshMapAfterElaboraPhase() {
    hideMapTooltips();
    if (map && typeof map.removeMarkers === 'function' && typeof map.addMarkers === 'function') {
        map.removeMarkers();
        map.addMarkers(getMarkersFromSintesi());
        applyRegionColorsFromSintesi();
        scheduleBubbleRebuild(120);
    }
    if (map && typeof map.updateSize === 'function') map.updateSize();
}

function formatSintesiLabel(info) {
    if (!info) return '';
    var name = (info.nazione || '').trim();
    if (!name) return '';
    var parts = [name];
    if (info.gg != null && info.gg !== '') parts.push('GG:' + displayMetric(info.gg));
    if (info.gr != null && info.gr !== '') parts.push('GR:' + displayMetric(info.gr));
    return parts.join(' ');
}

function displayMetric(val) {
    if (val == null) return '–';
    var s = String(val).trim();
    if (!s) return '–';
    var n = Number(s);
    if (!isNaN(n) && n === 3650) return '–';
    if (s === '3650') return '–';
    return s;
}

function formatAllParamsForTooltip(params) {
    if (!params || typeof params !== 'object') return '';
    var keys = Object.keys(params).filter(function(k) { return k !== 'nazione' && k !== 'commento' && typeof params[k] === 'number'; }).sort();
    return keys.map(function(k) {
        var name = escapeHtml(String(k).replace(/_/g, ' '));
        var val = Number(params[k]).toFixed(1);
        return '<div class="vision-tooltip-param"><span class="vision-tooltip-param-name">' + name + '</span><span class="vision-tooltip-param-value">' + val + '</span></div>';
    }).join('');
}

function escapeHtml(t) {
    if (!t) return '';
    var d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

// Genera il file EMWA_Pesato.json a partire da articolielaborati.json
async function elaboraNazioniPesate() {
    if (elaboraRunning) {
        logToConsole('Una elaborazione è già in corso. Attendere il completamento.', 'warn');
        return;
    }
    setElaboraButtonsRunning(true);
    logToConsole('Avvio elaborazione EMWA_Pesato.json (nazioni pesate)...', 'info');
    try {
        var res = await fetch('/api/elabora-nazioni-pesate', { method: 'POST' });
        var data = await res.json();
        if (!res.ok || !data.success) {
            logToConsole('Errore Elabora Nazioni Pesate: ' + (data && data.error ? data.error : ('HTTP ' + res.status)), 'error');
            return;
        }
        var total = Number(data.count) || 0;
        logToConsole('Elabora Nazioni Pesate completata: ' + total + ' valori totali scritti in EMWA_Pesato.json', total > 0 ? 'success' : 'info');
        logToConsole('Nota: per stabilità, EMWA_Pesato usa al massimo 333 articoli recenti (indipendentemente dal periodo di retroelaborazione).', 'info');
    } catch (e) {
        logToConsole('Errore chiamata Elabora Nazioni Pesate: ' + e.message, 'error');
    } finally {
        setElaboraButtonsRunning(false);
    }
}

async function elaboraPesatiERiassunto() {
    if (elaboraRunning) {
        logToConsole('Una elaborazione è già in corso. Attendere il completamento.', 'warn');
            return;
        }
    setElaboraButtonsRunning(true);
    logToConsole('Avvio generazione EMWA_Pesato.json + EMWA_Pesato_Sommato.json + Articoli_riassunto.json...', 'info');
    try {
        // /api/elabora-nazioni-pesate genera EMWA_Pesato.json, EMWA_Pesato_Sommato.json e Articoli_riassunto.json
        var res = await fetch('/api/elabora-nazioni-pesate', { method: 'POST' });
        var data = await res.json();
        if (!res.ok || !data.success) {
            logToConsole('Errore Pesati + Riassunto: ' + (data && data.error ? data.error : ('HTTP ' + res.status)), 'error');
            return;
        }
        var total = Number(data.count) || 0;
        logToConsole('Elaborazione Pesati + Riassunto completata: ' + total + ' valori totali scritti in EMWA_Pesato.json. Generati anche EMWA_Pesato_Sommato.json e Articoli_riassunto.json.', total > 0 ? 'success' : 'info');
        logToConsole('Nota: per stabilità, EMWA_Pesato usa al massimo 333 articoli recenti (indipendentemente dal periodo di retroelaborazione).', 'info');
    } catch (e) {
        logToConsole('Errore Pesati + Riassunto: ' + e.message, 'error');
    } finally {
        setElaboraButtonsRunning(false);
    }
}

async function elaboraErrori() {
    var btn = document.querySelector('button[onclick="elaboraErrori()"]');
    if (btn && btn.disabled) {
        logToConsole('Una elaborazione è già in corso. Attendere il completamento.', 'warn');
        return;
    }
    var originalText = btn ? btn.textContent : '';
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Elabora errori…';
    }
    logToConsole('Avvio rielaborazione degli errori presenti in errori.json...', 'info');
    try {
        var res = await fetch('/api/elabora-errori', { method: 'POST' });
        var data = await res.json().catch(function () { return null; });
        if (!res.ok || !data || data.success === false) {
            var errMsg = (data && data.error) ? data.error : ('HTTP ' + res.status);
            logToConsole('Errore Elabora errori: ' + errMsg, 'error');
            return;
        }
        var total = Number(data.total || 0);
        var processed = Number(data.processed || 0);
        var successCount = Number(data.success_count || 0);
        var remaining = Number(data.remaining_errori || 0);
        logToConsole('Elabora errori completata. Totale in errori.json: ' + total + ', processati: ' + processed + ', corretti: ' + successCount + ', ancora errati: ' + remaining + '.', 'success');
        // Aggiorna pannelli che dipendono da EMWA / Articoli_riassunto e lista errori
        try {
            await refreshAcceptedList();
            await refreshNationAggregate();
            await refreshNationSintesi();
            await refreshArticlesDateRangeLabel();
        } catch (e) {
            logToConsole('Warning: refresh dopo Elabora errori parzialmente fallito: ' + e.message, 'warn');
        }
    } catch (e) {
        logToConsole('Errore chiamata Elabora errori: ' + e.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText || 'Elabora errori';
        }
    }
}

async function elaboraSintesiPesata() {
    if (elaboraRunning) {
        logToConsole('Una elaborazione è già in corso. Attendere il completamento.', 'warn');
        return;
    }
    setElaboraButtonsRunning(true);
    logToConsole('Avvio elaborazione sintesi (solo le 2 sintesi)...', 'info');
    try {
        var res = await fetch('/api/elabora-sintesi-pesata', { method: 'POST' });
        var data = await res.json();
        if (!res.ok || !data.success) {
            logToConsole('Errore Elabora sintesi: ' + (data && data.error ? data.error : ('HTTP ' + res.status)), 'error');
            return;
        }
        var total = Number(data.count) || 0;
        var logShowResponses = !!(document.getElementById('log-show-responses') && document.getElementById('log-show-responses').checked);
        if (logShowResponses && data.ai_response) {
            var s = String(data.ai_response);
            logToConsole('[IA risposta question_EMWA_Pesato_Sommato] ' + (s.length > 2000 ? s.substring(0, 2000) + '...' : s), 'info');
        }
        await refreshNationSintesi();
        await refreshNationSintesiIaPesata();
        refreshMapAfterElaboraPhase();
        logToConsole('Elabora sintesi completata: ' + total + ' nazioni in sintesi_EMWA_Pesato_Sommato.json e sintesi_EMWA_Pesato_Sommato_IA.json', total > 0 ? 'success' : 'info');
    } catch (e) {
        logToConsole('Errore chiamata Elabora sintesi: ' + e.message, 'error');
    } finally {
        setElaboraButtonsRunning(false);
    }
}

async function generaNote() {
    if (elaboraRunning) {
        logToConsole('Una elaborazione è già in corso. Attendere il completamento.', 'warn');
        return;
    }
    setElaboraButtonsRunning(true);
    logToConsole('Avvio generazione note (solo note.json da Articoli_riassunto)...', 'info');
    try {
        var logShowQuestions = !!(document.getElementById('log-show-questions') && document.getElementById('log-show-questions').checked);
        var logShowResponses = !!(document.getElementById('log-show-responses') && document.getElementById('log-show-responses').checked);
        const res = await fetch('/api/elabora-solo-note', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            logToConsole('Errore Genera Note: ' + (data && data.error ? data.error : ('HTTP ' + res.status)), 'error');
            return;
        }
        if (logShowQuestions && data.note_request) {
            var rq = String(data.note_request);
            logToConsole('[IA invio question_note] ' + (rq.length > 2000 ? rq.substring(0, 2000) + '...' : rq), 'info');
        }
        if (logShowResponses && data.note_response) {
            var s = String(data.note_response);
            logToConsole('[IA risposta question_note] ' + (s.length > 2000 ? s.substring(0, 2000) + '...' : s), 'info');
        }
        await refreshNationNote();
        refreshMapAfterElaboraPhase();
        await refreshNoteListPanel();
        logToConsole('Genera Note completata: note.json aggiornato.', 'success');
        } catch (e) {
        logToConsole('Errore chiamata Genera Note: ' + e.message, 'error');
    } finally {
        setElaboraButtonsRunning(false);
    }
}

async function generaVRed() {
    if (elaboraRunning) {
        logToConsole('Una elaborazione è già in corso. Attendere il completamento.', 'warn');
        return;
    }
    setElaboraButtonsRunning(true);
    logToConsole('Avvio generazione VRed (solo sintesiVRED.json da Articoli_riassunto)...', 'info');
    try {
        const res = await fetch('/api/rigenera-sintesi-vred', { method: 'POST' });
        var data = null;
        try {
            data = await res.json();
        } catch (_) {
            data = {};
        }
        var ok = res.ok && (data && (data.ok === true || data.success === true));
        if (!ok) {
            logToConsole('Errore Genera VRed: ' + (data && data.error ? data.error : ('HTTP ' + res.status)), 'error');
            if (data && data.error && (data.error.indexOf('vuota') !== -1 || data.error.indexOf('non parsabile') !== -1)) {
                logToConsole('sintesiVRED.json non modificato; puoi riprovare con il pulsante Refresh accanto all\'avviso.', 'info');
            }
        } else {
            logToConsole('Genera VRed completata: sintesiVRED.json aggiornato.', 'success');
            var autoSendEmailEnabled = !!(document.getElementById('auto-send-email') && document.getElementById('auto-send-email').checked);
            if (autoSendEmailEnabled) {
                await openVisionEmail({ silent: true });
            }
        }
        await refreshSintesiVRed();
        refreshMapAfterElaboraPhase();
    } catch (e) {
        logToConsole('Errore chiamata Genera VRed: ' + e.message, 'error');
        await refreshSintesiVRed();
        refreshMapAfterElaboraPhase();
    } finally {
        setElaboraButtonsRunning(false);
    }
}

// Disegna un fumetto (rettangolo arrotondato senza punta) dietro ogni label, con un pallino colorato a sinistra
// (all'interno del fumetto), agganciato alla posizione della nazione.
// In jsvectormap cerchi e label sono in gruppi separati: #jvm-markers-group e #jvm-markers-labels-group (stesso ordine).
function wrapMarkerLabelsInBubbles() {
    var container = document.getElementById('world-map');
    if (!container) return;
    var svg = container.querySelector('svg');
    if (!svg) return;
    var labelsGroup = svg.querySelector('#jvm-markers-labels-group');
    var markersGroup = svg.querySelector('#jvm-markers-group');
    if (!labelsGroup || !markersGroup) return;
    var paddingX = 15;
    var paddingY = 4;
    var dotLeftMargin = 5;  // distanza pallino dal bordo sinistro del fumetto
    var dotTextGap = 5;    // spazio tra pallino e titolo (nome nazione)
    var rx = 10;

    // Ripristina i testi nei gruppi fumetto in labelsGroup, poi rimuovi rect/tail/gruppi (così zoom/pan può ricalcolare)
    svg.querySelectorAll('.nation-marker-bubble-group').forEach(function (g) {
        var textEl = g.querySelector('text');
        if (textEl) labelsGroup.appendChild(textEl);
        g.remove();
    });
    svg.querySelectorAll('.nation-marker-bubble-rect, .nation-marker-bubble-tail, .nation-marker-bubble-dot, .nation-marker-bubble-line').forEach(function (el) { el.remove(); });

    var circles = markersGroup.querySelectorAll('circle');
    var texts = labelsGroup.querySelectorAll('text');
    var n = Math.min(circles.length, texts.length);
    for (var i = 0; i < n; i++) {
        var circle = circles[i];
        var text = texts[i];
        if (!text.textContent || !text.textContent.trim()) continue;
        var r = parseFloat(circle.getAttribute('r')) || 5;
        if (r > 15) continue;
        try {
            // In SVG \n non va a capo: sostituiamo il testo con <tspan> per riga
            var content = text.textContent.trim();
            var lines = content.split(/\n/);
            if (lines.length > 1) {
                var bbox0 = text.getBBox();
                var centerX = bbox0.x + bbox0.width / 2;
                while (text.firstChild) text.removeChild(text.firstChild);
                for (var j = 0; j < lines.length; j++) {
                    var tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
                    tspan.setAttribute('x', centerX);
                    tspan.setAttribute('dy', j === 0 ? '0' : '1.4em');
                    if (j === 0) {
                        tspan.setAttribute('font-weight', 'bold;');
                        //tspan.setAttribute('letter-spacing', '.08em');
                        tspan.setAttribute('font-size', '1.2em');
                    }
                    if (j >= 1) {
                        //tspan.setAttribute('letter-spacing', '.08em');
                        tspan.setAttribute('font-size', '1em');
                    }
                        
                    tspan.textContent = lines[j];
                    text.appendChild(tspan);
                }
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('x', centerX);
                text.setAttribute('y', bbox0.y);
            }
            var bbox = text.getBBox();
            var fill = circle.getAttribute('fill') || circle.style.fill || '#6b7280';
            var stroke = '#1f2937';
            var cx = parseFloat(circle.getAttribute('cx'));
            var cy = parseFloat(circle.getAttribute('cy'));

            var rectX = bbox.x - paddingX;
            var rectY = bbox.y - paddingY;
            var rectW = bbox.width + 2 * paddingX + dotTextGap;
            var rectH = bbox.height + 2 * paddingY;

            // Rettangolo del fumetto
            var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('class', 'nation-marker-bubble-rect');
            rect.setAttribute('x', rectX);
            rect.setAttribute('y', rectY);
            rect.setAttribute('width', rectW);
            rect.setAttribute('height', rectH);
            rect.setAttribute('rx', rx);
            rect.setAttribute('ry', rx);
            rect.setAttribute('fill', 'rgba(255,255,255,0.18)');
            rect.setAttribute('stroke', 'rgba(255,255,255,0.35)');
            rect.setAttribute('stroke-width', '1');
            rect.setAttribute('pointer-events', 'none');
            labelsGroup.insertBefore(rect, text);

            // Pallino colorato distanziato dal testo della nazione, ma sempre dentro il fumetto
            var dotRadius = (r || 5);
            var maxRadius = Math.max(3, (paddingX / 2) - 1);
            if (dotRadius > maxRadius) dotRadius = maxRadius;
            var dotCx = rectX + dotRadius + dotLeftMargin;
            var dotCy = rectY + rectH / 2;
            var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('class', 'nation-marker-bubble-dot');
            dot.setAttribute('cx', dotCx);
            dot.setAttribute('cy', dotCy);
            dot.setAttribute('r', dotRadius);
            dot.setAttribute('fill', fill);
            dot.setAttribute('stroke', stroke);
            dot.setAttribute('stroke-width', '1');
            dot.setAttribute('pointer-events', 'none');
            labelsGroup.insertBefore(dot, text);

            // Raggruppa rect + pallino + text
            var attachY = rectY + rectH; // ancora allineato alla nazione, ma senza stanghetta visibile
            var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', 'nation-marker-bubble-group');
            var nextEl = text.nextSibling;
            g.appendChild(rect);
            g.appendChild(dot);
            g.appendChild(text);
            labelsGroup.insertBefore(g, nextEl);

            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('x', rectX + rectW / 2 + dotTextGap);

            var bubbleAnchorX = dotCx;
            g.setAttribute('data-marker-index', String(i));
            g.setAttribute('data-bubble-anchor-x', String(bubbleAnchorX));
            g.setAttribute('data-attach-y', String(attachY));
            g.setAttribute('transform', 'translate(' + (cx - bubbleAnchorX) + ',' + (cy - attachY) + ')');
        } catch (e) { /* getBBox può fallire se il testo non è ancora renderizzato */ }
    }
}

function updateMarkerBubblePositions() {
    var container = document.getElementById('world-map');
    if (!container) return;
    var svg = container.querySelector('svg');
    if (!svg) return;
    var labelsGroup = svg.querySelector('#jvm-markers-labels-group');
    var markersGroup = svg.querySelector('#jvm-markers-group');
    if (!labelsGroup || !markersGroup) return;
    var circles = markersGroup.querySelectorAll('circle');
    var groups = labelsGroup.querySelectorAll('.nation-marker-bubble-group');
    groups.forEach(function (g) {
        var idx = parseInt(g.getAttribute('data-marker-index') || '', 10);
        if (isNaN(idx) || idx < 0 || idx >= circles.length) return;
        var anchorX = parseFloat(g.getAttribute('data-bubble-anchor-x') || '');
        var attachY = parseFloat(g.getAttribute('data-attach-y') || '');
        if (isNaN(anchorX) || isNaN(attachY)) return;
        var circle = circles[idx];
        var cx = parseFloat(circle.getAttribute('cx'));
        var cy = parseFloat(circle.getAttribute('cy'));
        if (isNaN(cx) || isNaN(cy)) return;
        g.setAttribute('transform', 'translate(' + (cx - anchorX) + ',' + (cy - attachY) + ')');
    });
}

function scheduleBubbleMove() {
    if (bubbleMoveRaf != null) return;
    bubbleMoveRaf = window.requestAnimationFrame(function () {
        bubbleMoveRaf = null;
        updateMarkerBubblePositions();
    });
}

function scheduleBubbleRebuild(delayMs) {
    if (bubbleRebuildTimer) clearTimeout(bubbleRebuildTimer);
    var initialDelay = typeof delayMs === 'number' ? delayMs : 80;
    function attempt() {
        bubbleRebuildTimer = null;
        var container = document.getElementById('world-map');
        if (!container) return;
        var svg = container.querySelector('svg');
        if (!svg) {
            // SVG non ancora pronto: ritenta fra poco
            bubbleRebuildTimer = setTimeout(attempt, 100);
            return;
        }
        var labelsGroup = svg.querySelector('#jvm-markers-labels-group');
        var markersGroup = svg.querySelector('#jvm-markers-group');
        var hasTexts = labelsGroup && labelsGroup.querySelectorAll('text').length > 0;
        var hasMarkers = markersGroup && markersGroup.querySelectorAll('circle').length > 0;
        if (!hasTexts || !hasMarkers) {
            // Marker/label non ancora disponibili: ritenta fra poco
            bubbleRebuildTimer = setTimeout(attempt, 120);
            return;
        }
        wrapMarkerLabelsInBubbles();
        updateMarkerBubblePositions();
    }
    bubbleRebuildTimer = setTimeout(attempt, initialDelay);
}

function initMap() {
    if (document.getElementById('world-map')) {
        var markers = getMarkersFromSintesi();
        map = new jsVectorMap({
            selector: '#world-map',
            map: 'world',
            zoomOnScroll: false,
            zoomButtons: true,
            markers: markers,
            visualizeData: {
                scale: ['#eeeeee', '#999999'],
                values: {}
            },
            markerStyle: {
                initial: {
                    fill: '#6b7280',
                    stroke: '#1f2937',
                    r: 5
                },
                hover: { r: 6 },
                selected: {}
            },
            markerLabelStyle: {
                initial: {
                    fill: '#111',
                    fontSize: '11px',
                    fontWeight: 'normal'
                },
                hover: { fill: '#000' }
            },
            labels: {
                markers: {
                    render: function(marker) {
                        // Fumetto: solo nome della nazione
                        var name = marker.nazione || marker.name || '';
                        return name || '';
                    }
                }
            },
            regionStyle: {
                initial: {
                    fill: '#2a2a2a',
                    stroke: '#444',
                    strokeWidth: 0.5,
                    fillOpacity: 1
                },
                hover: {
                    fillOpacity: 0.8,
                    cursor: 'pointer',
                    fill: '#d27555'
                },
                selected: {
                    fill: '#d27555'
                }
            },
            backgroundColor: 'transparent',
            onMarkerTooltipShow: function(event) {
                event.preventDefault();
            },
            onRegionTooltipShow: function(event, tip, code) {
                var c = (code || '').toLowerCase();
                var elabInfo = nationSintesi.byCode && nationSintesi.byCode[c];
                var iaInfo = nationSintesiIa.byCode && nationSintesiIa.byCode[c];
                var ggBase = (elabInfo && (elabInfo.gg != null || elabInfo.GG != null)) ? String(elabInfo.gg != null ? elabInfo.gg : elabInfo.GG) : '';
                var grBase = (elabInfo && (elabInfo.gr != null || elabInfo.GR != null)) ? String(elabInfo.gr != null ? elabInfo.gr : elabInfo.GR) : '';
                var ggIa = (iaInfo && (iaInfo.gg != null || iaInfo.GG != null)) ? String(iaInfo.gg != null ? iaInfo.gg : iaInfo.GG) : '';
                var grIa = (iaInfo && (iaInfo.gr != null || iaInfo.GR != null)) ? String(iaInfo.gr != null ? iaInfo.gr : iaInfo.GR) : '';
                // Per la visibilità del popup considera prima i valori IA, con fallback ai base
                var ggEff = ggIa !== '' ? ggIa : ggBase;
                var grEff = grIa !== '' ? grIa : grBase;
                var ggNum = (ggEff !== '' && !isNaN(parseInt(ggEff, 10))) ? parseInt(ggEff, 10) : NaN;
                var grNum = (grEff !== '' && !isNaN(parseInt(grEff, 10))) ? parseInt(grEff, 10) : NaN;
                var showPopup = (!isNaN(ggNum) && ggNum < 365) || (!isNaN(grNum) && grNum < 365);
                if (!showPopup) {
                    event.preventDefault();
                    var tipNodes = document.querySelectorAll('.jvm-tooltip');
                    tipNodes.forEach(function (el) { el.style.display = 'none'; el.style.opacity = '0'; el.style.visibility = 'hidden'; });
                    return;
                }
                var tipNodes = document.querySelectorAll('.jvm-tooltip');
                if (tipNodes.length > 0) {
                    var tipEl = tipNodes[tipNodes.length - 1];
                    tipEl.style.display = 'block';
                    tipEl.style.opacity = '1';
                    tipEl.style.visibility = 'visible';
                    tipEl.style.pointerEvents = 'auto';
                }
                var name = (elabInfo && elabInfo.nazione) || (iaInfo && iaInfo.nazione) || (nationSintesi.byCode && nationSintesi.byCode[c] && nationSintesi.byCode[c].nazione) || (ISO_CODE_TO_NAME[c] || c);
                var ggDisp = ggBase !== '' ? escapeHtml(displayMetric(ggBase)) : '–';
                var grDisp = grBase !== '' ? escapeHtml(displayMetric(grBase)) : '–';
                var ggIaDisp = ggIa !== '' ? escapeHtml(displayMetric(ggIa)) : '–';
                var grIaDisp = grIa !== '' ? escapeHtml(displayMetric(grIa)) : '–';
                var noteHtml = '';
                var noteVal = (nationNote.byCode && nationNote.byCode[c]) ? nationNote.byCode[c] : null;
                var noteText = '';
                var gaText = '';
                var pctNote = null;
                if (noteVal && typeof noteVal === 'object') {
                    if (noteVal.nota != null) noteText = String(noteVal.nota);
                    else if (noteVal.note != null) noteText = String(noteVal.note);
                    if (noteVal.GA != null) gaText = String(noteVal.GA);
                    else if (noteVal.ga != null) gaText = String(noteVal.ga);
                    var pctRaw = noteVal.PercentualeCertezza != null ? noteVal.PercentualeCertezza : noteVal['Percentuale di certezza'];
                    if (typeof pctRaw === 'number' && pctRaw >= 0 && pctRaw <= 100) pctNote = Math.round(pctRaw);
                    else if (pctRaw != null) { var nP = parseInt(String(pctRaw).trim(), 10); if (isFinite(nP) && nP >= 0 && nP <= 100) pctNote = nP; }
                } else if (typeof noteVal === 'string') {
                    noteText = noteVal;
                }
                // Mostra blocco nota solo se c'è una nota; "Giorni di attuazione" e "Percentuale di certezza" se presenti
                    if (noteText) {
                    noteHtml = '<div class="vision-tooltip-note">';
                        noteHtml += escapeHtml(noteText);
                    if (gaText) {
                        noteHtml += '<br>';
                        noteHtml += '<span class="vision-tooltip-ga">Giorni di attuazione: ' + escapeHtml(displayMetric(gaText)) + '</span>';
                    }
                    if (pctNote != null) {
                        noteHtml += '<br>';
                        noteHtml += '<span class="vision-tooltip-pct">Percentuale di certezza: ' + escapeHtml(String(pctNote)) + '%</span>';
                    }
                    noteHtml += '</div>';
                }
                var html = '<div class="vision-tooltip">' +
                    '<div class="vision-tooltip-title">' + escapeHtml(name) + '</div>' +
                    '<div class="vision-tooltip-metrics">Giorni alla Guerra (IA): ' + ggIaDisp + '</div>' +
                    '<div class="vision-tooltip-metrics">Giorni al Nucleare (IA): ' + grIaDisp + '</div>' +
                    '<div class="vision-tooltip-metrics">Giorni alla Guerra (storico): ' + ggDisp + '</div>' +
                    '<div class="vision-tooltip-metrics">Giorni al Nucleare (storico): ' + grDisp + '</div>' +
                    noteHtml +
                    '</div>';
                tip.text(html, true);
            },
            onRegionTooltipHide: function() {
                hideMapTooltips();
            },
            onViewportChange: function() {
                hideMapTooltips();
                scheduleBubbleMove();
                scheduleBubbleRebuild(90);
            }
        });
        applyRegionColorsFromSintesi();
        var mapEl = document.getElementById('world-map');
        if (mapEl) {
            mapEl.addEventListener('pointerdown', function () { isMapPointerDown = true; }, { passive: true });
            mapEl.addEventListener('pointermove', function (e) {
                // Se il puntatore non è sopra una regione, nascondi i popup
                if (!e.target.closest('.jvm-region')) {
                    hideMapTooltips();
                }
                if (isMapPointerDown) scheduleBubbleMove();
            }, { passive: true });
            mapEl.addEventListener('mouseleave', function () {
                hideMapTooltips();
            }, { passive: true });
        }
        window.addEventListener('pointerup', function () {
            if (!isMapPointerDown) return;
            isMapPointerDown = false;
            scheduleBubbleMove();
            scheduleBubbleRebuild(60);
        }, { passive: true });
        setTimeout(function tryBubbles() {
            applyRegionColorsFromSintesi();
            wrapMarkerLabelsInBubbles();
            updateMarkerBubblePositions();
            var labelsGroup = document.querySelector('#world-map #jvm-markers-labels-group');
            if (labelsGroup && labelsGroup.querySelectorAll('text').length > 0 && !document.querySelector('#world-map .nation-marker-bubble-rect')) {
                setTimeout(function () {
                    wrapMarkerLabelsInBubbles();
                    updateMarkerBubblePositions();
                }, 200);
            }
        }, 250);
        window.addEventListener('resize', function() {
            if (map) map.updateSize();
            scheduleBubbleMove();
            scheduleBubbleRebuild(100);
        });
    }
}

// A inizio programma: leggi sempre articolielaborati e aggiorna il count della barra; poi carica sintesi/aggregate e crea la mappa
document.addEventListener('DOMContentLoaded', async () => {
    initDebugCheckbox();
    initValiditySelector();
    initEmwaLookbackSelector();
    initJsonUpdateSelector();
    initAnalyzeConcurrentSelector();
    initBatchWaitSelector();
    initUrlDragDrop();
    // Toggle Accettati/Scartati nella lista articoli elaborati
    var toggle = document.querySelector('.accepted-toggle');
    if (toggle) {
        toggle.addEventListener('click', function (e) {
            var btn = e.target.closest('.accepted-toggle-btn');
            if (!btn) return;
            var mode = btn.getAttribute('data-mode') || 'accettati';
            if (mode !== acceptedViewMode) {
                acceptedViewMode = mode;
                Array.prototype.forEach.call(toggle.querySelectorAll('.accepted-toggle-btn'), function (b) {
                    b.classList.toggle('active', b === btn);
                });
                applyAcceptedListVisibility();
            }
        });
    }
    initSidebarPanels();
    await refreshJsonFolders();
    await refreshEmailRecipients();
    try {
        await loadFolderSettings();
    } catch (settingsErr) {
        logToConsole('Errore caricamento impostazioni cartella: ' + settingsErr.message, 'error');
    }
    await refreshArticlesDateRangeLabel();
    await updateArticolielaboratiCountDisplay();
    await refreshNationSintesi();
    await refreshNationAggregate();
    await refreshNationSintesiAlternativa();
    await refreshNationEmwaIa();
    await refreshNationSintesiIaPesata();
    await refreshNationNote();
    await refreshNationSintesiV4();
    await refreshNationSintesiV5();
    await refreshNationSintesiElabIa();
    await refreshSintesiVRed();
    await refreshAcceptedList();
    applyAcceptedListVisibility();
    initMap();
    initAiChatPanel();
    initUrgentInfoButton();
    initUrgentRegeneraButton();
    startServerLogPolling();
    setInterval(refreshAcceptedList, 5000);
    // Aggiorna periodicamente il range date e gli agenti attivi vicino al titolo (frequenza ridotta per evitare sfarfallii)
    setInterval(refreshArticlesDateRangeLabel, 5000);
    // All'avvio dell'interfaccia il pulsante parte sempre da START.
    // Questo evita che, dopo un riavvio del server, il pulsante venga messo a STOP solo per via di localStorage.
            setStartStopButton(false);
});

// Lista URL caricata da loadFolderSettings() (settaggio cartella o lista univoca /api/urls)
