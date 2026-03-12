require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const nodemailer = require('nodemailer');
const FormData = require('form-data');
const config = require('./config');
const ScraperFactory = require('./scrapers/ScraperFactory');
const abortCheck = require('./scrapers/abortCheck');
const nations = require('./nations');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3002;
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || 'visionapi';

function setCorsHeadersForResponse(req, res) {
    var origin = (req.headers.origin || '').toString().trim();
    if (origin && (origin === 'https://progredire.net' || origin === 'http://progredire.net')) {
        res.set('Access-Control-Allow-Origin', origin);
    } else {
        res.set('Access-Control-Allow-Origin', '*');
    }
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function requirePasswordForApiHost(req, res, next) {
    // Host reale: da X-Forwarded-Host se dietro proxy (nginx), altrimenti Host
    var hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
    const host = hostHeader.split(',')[0].trim().split(':')[0].toLowerCase();
    if (host !== 'api.progredire.net') return next();
    // Le chiamate API da Vision App (progredire.net) non inviano credenziali: escludi /api/* così la chat funziona
    var path = (req.originalUrl || req.url || req.path || '').toString().split('?')[0];
    if (path.indexOf('/api/') === 0) return next();

    const realm = 'Solo password (lascia vuoto il nome utente)';
    const header = req.headers.authorization || '';
    setCorsHeadersForResponse(req, res);
    if (!header.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="' + realm + '"');
        return res.status(401).send('Inserisci solo la password.');
    }
    var pass = '';
    try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    } catch (_) {
        res.set('WWW-Authenticate', 'Basic realm="' + realm + '"');
        return res.status(401).send('Credenziali non valide');
    }
    if (pass === BASIC_AUTH_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="' + realm + '"');
    return res.status(401).send('Credenziali non valide');
}

app.use(requirePasswordForApiHost);

const EMAIL_RECIPIENTS = String(process.env.MAIL_TO_LIST || process.env.MAIL_TO || 'studio.dmd.bk@gmail.com')
    .split(',')
    .map(function (v) { return String(v || '').trim(); })
    .filter(Boolean);
function normalizeOrigin(v) {
    return String(v || '').trim().replace(/\/+$/, '');
}
function isLocalhostOrigin(v) {
    try {
        var u = new URL(normalizeOrigin(v));
        var h = String(u.hostname || '').toLowerCase();
        return h === 'localhost' || h === '127.0.0.1' || h === '::1';
    } catch (_) {
        return false;
    }
}
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
const CORS_ORIGIN_DEFAULTS = [
    'https://progredire.net', 'http://progredire.net'
].map(normalizeOrigin).filter(Boolean);
const CORS_ORIGIN_ALLOWLIST = Array.from(new Set(CORS_ORIGINS.concat(CORS_ORIGIN_DEFAULTS)));

// Middleware manuale per gestire origin 'null' (file locali) o vuote, impostando Access-Control-Allow-Origin: *
app.use((req, res, next) => {
    const origin = req.get('origin');
    if (!origin || origin === 'null') {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
    }
    next();
});

app.use(cors({
    origin: function (origin, callback) {
        var currentOrigin = normalizeOrigin(origin);
        // Se origin è vuota (es. server-to-server, curl) o "null" (file locale), consenti
        if (!currentOrigin || currentOrigin === 'null') return callback(null, true);
        
        if (isLocalhostOrigin(currentOrigin)) return callback(null, true);
        if (CORS_ORIGIN_ALLOWLIST.length === 0) return callback(null, true);
        if (CORS_ORIGIN_ALLOWLIST.indexOf(currentOrigin) !== -1) return callback(null, true);
        
        console.warn('[CORS] Origin bloccata:', currentOrigin);
        return callback(new Error('Origin non consentita dal CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public', { index: 'ai.html' }));
// Vision App chat: servita sotto /vision/ (index + app.js + styles.css)
const visionAppDir = path.join(__dirname, 'Vision App');
app.get('/vision', function (req, res) {
  res.redirect(302, '/vision/');
});
app.use('/vision', express.static(visionAppDir));

// Favicon: logo VISION (stesso logo della Vision App)
const faviconPath = path.join(visionAppDir, 'V1.png');
app.get('/favicon.ico', function (req, res) {
  res.type('image/png');
  res.sendFile(faviconPath, function (err) {
    if (err && err.code === 'ENOENT') res.status(204).end();
  });
});

// Gestione cartelle JSON: root fisica + sottocartella attiva selezionabile da UI
const ROOT_JSON_DIR = path.join(__dirname, 'Json');
const ACTIVE_JSON_FOLDER_FILE = path.join(ROOT_JSON_DIR, '.active-folder.json');

let activeJsonSubdir = ''; // '' = cartella principale Json
let JSON_DIR = ROOT_JSON_DIR;

// Lista URL univoca: sempre in Json/urls.json (si modifica solo quella). Ogni cartella ha solo i settaggi della lista in folder-settings.url_list_settings.
const URLS_FILE = path.join(ROOT_JSON_DIR, 'urls.json');
const EMAIL_RECIPIENTS_FILE = path.join(ROOT_JSON_DIR, 'email-recipients.json');
let RESULTS_FILE = path.join(JSON_DIR, 'results.json');
let ARTICLES_FILE = path.join(JSON_DIR, 'articles.json');
let ARTICOLI_ELABORATI_FILE = path.join(JSON_DIR, 'articolielaborati.json');
let LINK_SECONDARI_FILE = path.join(JSON_DIR, 'link_secondari.json');
let SINTESI_NAZIONI_FILE = path.join(JSON_DIR, 'sintesinazioni.json');
let SINTESI_ALTERNATIVA_FILE = path.join(JSON_DIR, 'sintesialternativa.json');
let NOTE_FILE = path.join(JSON_DIR, 'note.json');
let NAZIONI_ELABORATE_FILE = path.join(JSON_DIR, 'nazionielaborate.json');
let NAZIONI_ELABORATE_PESATO_FILE = path.join(JSON_DIR, 'EMWA_Pesato.json');
let NAZIONI_ELABORATE_PESATO_SOMMATO_FILE = path.join(JSON_DIR, 'EMWA_Pesato_Sommato.json');
let NAZIONI_EWMA_FILE = path.join(JSON_DIR, 'nazioniEWMA.json'); // V0 EWMA deprecato: file mantenuto solo per compatibilità (vuoto)
let NAZIONI_EMWA_IA_FILE = path.join(JSON_DIR, 'nazioniEMWA_IA.json'); // Deprecato
let SINTESI_EMWA_FILE = path.join(JSON_DIR, 'sintesiEMWA.json'); // Deprecato
let SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE = path.join(JSON_DIR, 'sintesi_EMWA_Pesato_Sommato.json');
let SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_IA_FILE = path.join(JSON_DIR, 'sintesi_EMWA_Pesato_Sommato_IA.json'); // Deprecato
let ARTICOLI_RIASSUNTO_FILE = path.join(JSON_DIR, 'Articoli_riassunto.json');
let SINTESI_V4_FILE = path.join(JSON_DIR, 'sintesiV4.json'); // Deprecato
let SINTESI_V5_FILE = path.join(JSON_DIR, 'sintesiV5.json'); // Deprecato
let SINTESI_NAZIONI_ELAB_IA_FILE = path.join(JSON_DIR, 'sintesiNazioniElaborate_IA.json'); // V6 disabilitato: mantiene solo compatibilità file vuoto
let SINTESI_VRED_FILE = path.join(JSON_DIR, 'sintesiVRED.json');
let QUESTIONS_FILE = path.join(JSON_DIR, 'Questions.json');
let SCARTATI_FILE = path.join(JSON_DIR, 'Scartati.json');
let ACCETTATI_FILE = path.join(JSON_DIR, 'Accettati.json');
let ERRORI_FILE = path.join(JSON_DIR, 'errori.json');
let FOLDER_SETTINGS_FILE = path.join(JSON_DIR, 'folder-settings.json');
let LOG_FILE = path.join(JSON_DIR, 'Log.txt');

// Flag globale per interrompere tempestivamente le elaborazioni e le chiamate IA lato server
let GLOBAL_ELAB_ABORTED = false;
let ACTIVE_AI_ABORT_CONTROLLERS = new Set();
const ELAB_TELEGRAM_STATUS_INTERVAL_MS = 30 * 60 * 1000; // 30 minuti
const ELAB_TELEGRAM_IDLE_STOP_MS = 20 * 60 * 1000; // stop reporter dopo 20 minuti senza attivita
let elabTelegramTicker = null;
let elabTelegramSending = false;
let elabStatus = {
    running: false,
    startedAt: null,
    currentPhase: 'idle',
    phaseChangedAt: null,
    processTotalUrls: 0,
    processProcessedUrls: 0,
    processActive: 0,
    lastUrl: '',
    lastUrlType: '',
    lastActivityAt: null,
    lastServerLogAt: null,
    lastServerLogMessage: '',
    lastAiResponseAt: null,
    lastAiResponseStage: '',
    lastAiResponsePreview: '',
    lastReportAt: null,
    lastReportedPhase: ''
};

// Contatore per aggiornamento periodico EMWA/Articoli_riassunto
let jsonAutoUpdatePending = 0;
let jsonAutoUpdateInProgress = false;

function registerAiAbortController(controller) {
    if (controller) ACTIVE_AI_ABORT_CONTROLLERS.add(controller);
    return controller;
}

function releaseAiAbortController(controller) {
    if (controller) ACTIVE_AI_ABORT_CONTROLLERS.delete(controller);
}

function abortActiveAiRequests() {
    ACTIVE_AI_ABORT_CONTROLLERS.forEach(function (controller) {
        try { controller(); } catch (_) {}
    });
    ACTIVE_AI_ABORT_CONTROLLERS.clear();
}

function nowIso() {
    return new Date().toISOString();
}

function markElabActivity() {
    elabStatus.lastActivityAt = Date.now();
}

function setElabPhase(phase) {
    var p = (phase == null) ? '' : String(phase).trim();
    if (!p) return;
    if (elabStatus.currentPhase !== p) {
        elabStatus.currentPhase = p;
        elabStatus.phaseChangedAt = Date.now();
    }
    markElabActivity();
}

function ensureElabReporterRunning(initialPhase) {
    if (!getTelegramElabReportEnabledFromFolderSettings()) return;
    if (!elabStatus.running) {
        elabStatus.running = true;
        elabStatus.startedAt = Date.now();
        elabStatus.lastReportAt = null;
        elabStatus.lastReportedPhase = '';
        elabStatus.processTotalUrls = 0;
        elabStatus.processProcessedUrls = 0;
        elabStatus.lastUrl = '';
        elabStatus.lastUrlType = '';
        elabStatus.lastAiResponseAt = null;
        elabStatus.lastAiResponseStage = '';
        elabStatus.lastAiResponsePreview = '';
        elabStatus.lastServerLogAt = null;
        elabStatus.lastServerLogMessage = '';
    }
    setElabPhase(initialPhase || elabStatus.currentPhase || 'elaborazione');
    if (elabTelegramTicker) return;
    elabTelegramTicker = setInterval(function () {
        sendElabTelegramStatus('periodic').catch(function (e) {
            console.warn('[VISION] Elab Telegram status periodic error:', e && e.message ? e.message : String(e));
        });
    }, ELAB_TELEGRAM_STATUS_INTERVAL_MS);
}

function stopElabReporter(reason) {
    if (elabTelegramTicker) {
        clearInterval(elabTelegramTicker);
        elabTelegramTicker = null;
    }
    elabStatus.running = false;
    elabStatus.processTotalUrls = 0;
    elabStatus.processProcessedUrls = 0;
    elabStatus.processActive = 0;
    if (reason) {
        elabStatus.currentPhase = 'stopped: ' + String(reason);
        elabStatus.phaseChangedAt = Date.now();
    }
}

function getElabInFlightUrlsCount() {
    try {
        if (typeof analyzeArticleInFlightByUrl !== 'object' || !analyzeArticleInFlightByUrl) return 0;
        return Object.keys(analyzeArticleInFlightByUrl).length;
    } catch (_) {
        return 0;
    }
}

function getElabAiLastLine() {
    var txt = (elabStatus.lastAiResponsePreview || '').trim();
    if (!txt) return '';
    return txt.length > 500 ? (txt.substring(0, 500) + '...') : txt;
}

function getElabTelegramTargets() {
    var chatId = String(process.env.TELEGRAM_REPORT_CHAT_ID || '').trim();
    if (!chatId) return [];
    if (/^tg:/i.test(chatId)) chatId = chatId.replace(/^tg:/i, '');
    if (/^telegram:/i.test(chatId)) chatId = chatId.replace(/^telegram:/i, '');
    return chatId ? [chatId] : [];
}

async function sendElabTelegramStatus(trigger) {
    if (!getTelegramElabReportEnabledFromFolderSettings()) {
        stopElabReporter('telegram report disabled');
        return;
    }
    if (!elabStatus.running) return;
    if (elabTelegramSending) return;
    elabTelegramSending = true;
    try {
        var tgToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
        if (!tgToken) return;
        var targets = getElabTelegramTargets();
        if (!targets.length) return;

        var nowMs = Date.now();
        var activeControllers = ACTIVE_AI_ABORT_CONTROLLERS.size;
        var inFlightUrls = getElabInFlightUrlsCount();
        var activeAgents = (typeof analyzeArticleConcurrent === 'number') ? analyzeArticleConcurrent : 0;
        var maxAgents = (typeof ANALYZE_ARTICLE_MAX === 'number') ? ANALYZE_ARTICLE_MAX : 1;
        var processLine = (elabStatus.processTotalUrls > 0)
            ? (String(elabStatus.processProcessedUrls) + '/' + String(elabStatus.processTotalUrls))
            : 'n/d';
        var lastAiLine = getElabAiLastLine() || 'n/d';
        var lastLogLine = (elabStatus.lastServerLogMessage || '').trim();
        if (lastLogLine.length > 400) lastLogLine = lastLogLine.substring(0, 400) + '...';
        if (!lastLogLine) lastLogLine = 'n/d';
        var phaseDelta = (elabStatus.lastReportedPhase && elabStatus.lastReportedPhase !== elabStatus.currentPhase)
            ? ('cambiata da "' + elabStatus.lastReportedPhase + '"')
            : 'invariata';

        var lines = [];
        lines.push('VISION - Stato elaborazione');
        lines.push('Trigger: ' + (trigger || 'periodic'));
        lines.push('Fase corrente: ' + (elabStatus.currentPhase || 'n/d') + ' (' + phaseDelta + ')');
        lines.push('Scraping progress: ' + processLine);
        lines.push('Agenti attivi: ' + activeAgents + '/' + maxAgents + ' | request AI in corso: ' + activeControllers + ' | URL in-flight: ' + inFlightUrls);
        if (elabStatus.lastUrl) lines.push('Ultimo URL: ' + elabStatus.lastUrl + (elabStatus.lastUrlType ? (' [' + elabStatus.lastUrlType + ']') : ''));
        lines.push('Ultima risposta IA: ' + lastAiLine);
        lines.push('Ultimo log: ' + lastLogLine);
        lines.push('Started: ' + (elabStatus.startedAt ? new Date(elabStatus.startedAt).toISOString() : 'n/d'));
        lines.push('Report time: ' + nowIso());
        var text = lines.join('\n');

        for (var i = 0; i < targets.length; i++) {
            await axios.post('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
                chat_id: targets[i],
                text: text
            }, { timeout: 15000 });
        }

        elabStatus.lastReportAt = nowMs;
        elabStatus.lastReportedPhase = elabStatus.currentPhase || '';
        markElabActivity();

        // Se periodico e non c'e piu attivita da un po', invia solo quest'ultimo e poi ferma reporter
        var idleMs = elabStatus.lastActivityAt ? (nowMs - elabStatus.lastActivityAt) : 0;
        if (trigger === 'periodic' && idleMs >= ELAB_TELEGRAM_IDLE_STOP_MS && activeControllers === 0 && activeAgents === 0 && inFlightUrls === 0 && elabStatus.processActive === 0) {
            stopElabReporter('idle');
        }
    } catch (e) {
        console.warn('[VISION] Elab Telegram status send error:', e && e.message ? e.message : String(e));
    } finally {
        elabTelegramSending = false;
    }
}

// Limite massimo articoli usati per EMWA_Pesato e Articoli_riassunto (indipendentemente dal tempo di retroelaborazione)
const MAX_ARTICOLI_ELABORAZIONE = 7777; 

// Statistiche ultime elaborazioni articoli (per log/risposta API)
let lastEmwaArticlesStats = null;
let lastRiassuntoArticlesStats = null;

function createMailTransport() {
    if (process.env.MAIL_HOST) {
        return nodemailer.createTransport({
            host: process.env.MAIL_HOST,
            port: process.env.MAIL_PORT ? parseInt(process.env.MAIL_PORT, 10) : 587,
            secure: process.env.MAIL_SECURE === 'true',
            auth: (process.env.MAIL_USER && process.env.MAIL_PASS) ? {
                user: process.env.MAIL_USER,
                pass: process.env.MAIL_PASS
            } : undefined
        });
    }
    if (process.env.MAIL_SENDMAIL === '1' || process.env.MAIL_SENDMAIL === 'true') {
        return nodemailer.createTransport({
            sendmail: true,
            newline: 'unix',
            path: process.env.MAIL_SENDMAIL_PATH || '/usr/sbin/sendmail'
        });
    }
    return null;
}

function applyActiveJsonDir() {
    JSON_DIR = activeJsonSubdir ? path.join(ROOT_JSON_DIR, activeJsonSubdir) : ROOT_JSON_DIR;
    RESULTS_FILE = path.join(JSON_DIR, 'results.json');
    ARTICLES_FILE = path.join(JSON_DIR, 'articles.json');
    ARTICOLI_ELABORATI_FILE = path.join(JSON_DIR, 'articolielaborati.json');
    LINK_SECONDARI_FILE = path.join(JSON_DIR, 'link_secondari.json');
    SINTESI_NAZIONI_FILE = path.join(JSON_DIR, 'sintesinazioni.json');
    SINTESI_ALTERNATIVA_FILE = path.join(JSON_DIR, 'sintesialternativa.json');
    NOTE_FILE = path.join(JSON_DIR, 'note.json');
    NAZIONI_ELABORATE_FILE = path.join(JSON_DIR, 'nazionielaborate.json');
    NAZIONI_ELABORATE_PESATO_FILE = path.join(JSON_DIR, 'EMWA_Pesato.json');
    NAZIONI_ELABORATE_PESATO_SOMMATO_FILE = path.join(JSON_DIR, 'EMWA_Pesato_Sommato.json');
    NAZIONI_EWMA_FILE = path.join(JSON_DIR, 'nazioniEWMA.json');
    NAZIONI_EMWA_IA_FILE = path.join(JSON_DIR, 'nazioniEMWA_IA.json');
    SINTESI_EMWA_FILE = path.join(JSON_DIR, 'sintesiEMWA.json');
    SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE = path.join(JSON_DIR, 'sintesi_EMWA_Pesato_Sommato.json');
    SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_IA_FILE = path.join(JSON_DIR, 'sintesi_EMWA_Pesato_Sommato_IA.json');
    ARTICOLI_RIASSUNTO_FILE = path.join(JSON_DIR, 'Articoli_riassunto.json');
    SINTESI_V4_FILE = path.join(JSON_DIR, 'sintesiV4.json');
    SINTESI_V5_FILE = path.join(JSON_DIR, 'sintesiV5.json');
    SINTESI_NAZIONI_ELAB_IA_FILE = path.join(JSON_DIR, 'sintesiNazioniElaborate_IA.json');
    SINTESI_VRED_FILE = path.join(JSON_DIR, 'sintesiVRED.json');
    QUESTIONS_FILE = path.join(JSON_DIR, 'Questions.json');
    SCARTATI_FILE = path.join(JSON_DIR, 'Scartati.json');
    ACCETTATI_FILE = path.join(JSON_DIR, 'Accettati.json');
    ERRORI_FILE = path.join(JSON_DIR, 'errori.json');
    FOLDER_SETTINGS_FILE = path.join(JSON_DIR, 'folder-settings.json');
    LOG_FILE = path.join(JSON_DIR, 'Log.txt');
}

function loadActiveJsonFolder() {
    try {
        if (fs.existsSync(ACTIVE_JSON_FOLDER_FILE)) {
            var raw = fs.readFileSync(ACTIVE_JSON_FOLDER_FILE, 'utf8');
            var obj = JSON.parse(raw);
            if (obj && typeof obj.active === 'string') {
                activeJsonSubdir = obj.active.trim();
            }
        }
    } catch (e) {
        console.warn('[VISION] Impossibile leggere .active-folder.json:', e.message);
        activeJsonSubdir = '';
    }
    applyActiveJsonDir();
}

loadActiveJsonFolder();

// Crea file JSON base se non esistono
(function ensureJsonFiles() {
    function ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    }
    function moveOldJsonIfPresent(fileName) {
        var oldPath = path.join(__dirname, fileName);
        var newPath = path.join(JSON_DIR, fileName);
        try {
            if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
                fs.renameSync(oldPath, newPath);
                process.stderr.write('[VISION] Spostato ' + fileName + ' -> ' + newPath + '\n');
            }
        } catch (e) {
            process.stderr.write('[VISION] Migrazione ' + fileName + ' fallita: ' + e.message + '\n');
        }
    }
    function tryArticoli(filePath) {
        if (fs.existsSync(filePath)) return true;
        fs.writeFileSync(filePath, '[]', 'utf8');
        return true;
    }
    function trySintesi(filePath) {
        if (fs.existsSync(filePath)) return true;
        fs.writeFileSync(filePath, '[]', 'utf8');
        return true;
    }
    ensureDir(ROOT_JSON_DIR);
    ensureDir(JSON_DIR);
    // Lista URL univoca: sempre in Json/ (urls.json solo in root)
    (function ensureGlobalUrls() {
        var globalUrlsPath = path.join(ROOT_JSON_DIR, 'urls.json');
        var oldPath = path.join(__dirname, 'urls.json');
        try {
            if (fs.existsSync(oldPath) && !fs.existsSync(globalUrlsPath)) {
                fs.renameSync(oldPath, globalUrlsPath);
                process.stderr.write('[VISION] Spostato urls.json -> ' + globalUrlsPath + '\n');
            }
        } catch (e) { process.stderr.write('[VISION] Migrazione urls.json fallita: ' + e.message + '\n'); }
        if (!fs.existsSync(globalUrlsPath)) fs.writeFileSync(globalUrlsPath, '[]', 'utf8');
    })();
    // Migrazione eventuali altri file JSON dalla root del progetto alla cartella attiva
    moveOldJsonIfPresent('results.json');
    moveOldJsonIfPresent('articles.json');
    moveOldJsonIfPresent('articolielaborati.json');
    moveOldJsonIfPresent('sintesinazioni.json');
    moveOldJsonIfPresent('sintesialternativa.json');
    moveOldJsonIfPresent('note.json');
    moveOldJsonIfPresent('nazionielaborate.json');
    moveOldJsonIfPresent('nazionielaborate_pesato.json'); // legacy name -> lasciato per compatibilità
    moveOldJsonIfPresent('nazionielaborate_pesato_sommato.json'); // legacy name -> lasciato per compatibilità
    // Deprecated files - kept for compatibility but marked as deprecated
    moveOldJsonIfPresent('nazioniEWMA.json');
    moveOldJsonIfPresent('nazioniEMWA_IA.json');
    moveOldJsonIfPresent('sintesiEMWA.json');
    moveOldJsonIfPresent('sintesi_nazionielaborate_pesato_sommato.json'); // legacy name
    moveOldJsonIfPresent('sintesiV4.json');
    moveOldJsonIfPresent('sintesiV5.json');
    moveOldJsonIfPresent('sintesiNazioniElaborate_IA.json');
    
    moveOldJsonIfPresent('sintesiVRED.json');
    moveOldJsonIfPresent('Questions.json');
    moveOldJsonIfPresent('Scartati.json');
    moveOldJsonIfPresent('Accettati.json');

    tryArticoli(URLS_FILE);
    tryArticoli(RESULTS_FILE);
    tryArticoli(ARTICLES_FILE);
    tryArticoli(ARTICOLI_ELABORATI_FILE);
    // I file di sintesi storiche (V1–V6, EMWA, alternative) non vengono più creati automaticamente all'avvio.
    // Rimane solo sintesiVRED.json (SINTESI_VRED_FILE) che può essere generato a richiesta.
    trySintesi(SINTESI_VRED_FILE);
    if (!fs.existsSync(LINK_SECONDARI_FILE)) fs.writeFileSync(LINK_SECONDARI_FILE, '[]', 'utf8');
    if (!fs.existsSync(NOTE_FILE)) fs.writeFileSync(NOTE_FILE, JSON.stringify({ byNation: {}, byCode: {} }, null, 2), 'utf8');
    if (!fs.existsSync(NAZIONI_ELABORATE_PESATO_FILE)) fs.writeFileSync(NAZIONI_ELABORATE_PESATO_FILE, JSON.stringify({}, null, 2), 'utf8');
    if (!fs.existsSync(NAZIONI_ELABORATE_PESATO_SOMMATO_FILE)) fs.writeFileSync(NAZIONI_ELABORATE_PESATO_SOMMATO_FILE, JSON.stringify({}, null, 2), 'utf8');
    if (!fs.existsSync(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE)) fs.writeFileSync(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE, JSON.stringify([], null, 2), 'utf8');
    if (!fs.existsSync(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_IA_FILE)) fs.writeFileSync(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_IA_FILE, '[]', 'utf8');
    // Deprecated files - create empty array if missing to avoid errors but mark as such
    if (!fs.existsSync(NAZIONI_EWMA_FILE)) fs.writeFileSync(NAZIONI_EWMA_FILE, '[]', 'utf8');
    if (!fs.existsSync(NAZIONI_EMWA_IA_FILE)) fs.writeFileSync(NAZIONI_EMWA_IA_FILE, '[]', 'utf8');
    if (!fs.existsSync(SINTESI_EMWA_FILE)) fs.writeFileSync(SINTESI_EMWA_FILE, '[]', 'utf8');
    if (!fs.existsSync(SINTESI_V4_FILE)) fs.writeFileSync(SINTESI_V4_FILE, '[]', 'utf8');
    if (!fs.existsSync(SINTESI_V5_FILE)) fs.writeFileSync(SINTESI_V5_FILE, '[]', 'utf8');
    if (!fs.existsSync(SINTESI_NAZIONI_ELAB_IA_FILE)) fs.writeFileSync(SINTESI_NAZIONI_ELAB_IA_FILE, '[]', 'utf8');

    if (!fs.existsSync(QUESTIONS_FILE)) fs.writeFileSync(QUESTIONS_FILE, '', 'utf8');
    if (!fs.existsSync(SCARTATI_FILE)) fs.writeFileSync(SCARTATI_FILE, '[]', 'utf8');
    if (!fs.existsSync(ACCETTATI_FILE)) fs.writeFileSync(ACCETTATI_FILE, '[]', 'utf8');
    if (!fs.existsSync(ERRORI_FILE)) fs.writeFileSync(ERRORI_FILE, '[]', 'utf8');
    if (!fs.existsSync(FOLDER_SETTINGS_FILE)) fs.writeFileSync(FOLDER_SETTINGS_FILE, JSON.stringify(defaultFolderSettings(), null, 2), 'utf8');
    process.stderr.write('[VISION] JSON dir -> ' + JSON_DIR + '\n');
    process.stderr.write('[VISION] articolielaborati.json -> ' + ARTICOLI_ELABORATI_FILE + '\n');
    process.stderr.write('[VISION] sintesinazioni.json -> ' + SINTESI_NAZIONI_FILE + '\n');
})();

// Global logs array for polling (ring buffer)
let serverLogs = [];
const SERVER_LOGS_MAX = 1000;

// Logger override
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function serverLogKind(msg) {
    if (/\b(User content|inizio user|fine user)\b/i.test(msg) && !/risposta/i.test(msg)) return 'question';
    if (/\b(inizio risposta|fine risposta|Risposta IA)\b/i.test(msg)) return 'response';
    if (msg.length > 150 && /^\s*[{\[]/m.test(msg.trim())) return 'question';
    return null;
}

function appendToLogFile(line) {
    try {
        if (LOG_FILE) fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    } catch (e) {
        try { originalConsoleError('[VISION] Log.txt write failed:', e.message); } catch (_) {}
    }
}

function clearLogFile() {
    try {
        if (LOG_FILE) fs.writeFileSync(LOG_FILE, '', 'utf8');
    } catch (e) {
        try { originalConsoleError('[VISION] Log.txt clear failed:', e.message); } catch (_) {}
    }
}

function pushServerLog(entry) {
    serverLogs.push(entry);
    if (serverLogs.length > SERVER_LOGS_MAX) {
        serverLogs.splice(0, serverLogs.length - SERVER_LOGS_MAX);
    }
    elabStatus.lastServerLogAt = Date.now();
    elabStatus.lastServerLogMessage = entry && entry.message != null ? String(entry.message) : '';
    var ts = (entry.timestamp || new Date().toISOString());
    var msg = (entry.message != null ? String(entry.message) : '');
    appendToLogFile('[' + ts + '] ' + msg);
}

console.log = function(...args) {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const kind = serverLogKind(msg);
    let type = 'info';
    if (/^\[MAX_TOKENS_TRUNCATED\]/.test(msg) || /^\[DEEPSEEK_CONTEXT_TRUNCATED\]/.test(msg)) type = 'fuchsia';
    pushServerLog({ message: msg, type: type, timestamp: new Date().toISOString(), kind: kind });
    originalConsoleLog.apply(console, args);
};

console.error = function(...args) {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    pushServerLog({ message: msg, type: 'error', timestamp: new Date().toISOString() });
    originalConsoleError.apply(console, args);
};

// API: Impostazioni AI (ritardo + domanda predefinita per il box)
app.get('/api/ai-settings', (req, res) => {
    var q = config.prompts && (config.prompts.question_per_article || config.prompts.article_analysis);
    res.json({
        delayBetweenRequestsMs: config.ai_delay_between_requests_ms || 0,
        default_question: q || ''
    });
});

// API: Abort elaborazione corrente lato server (STOP immediato degli agenti IA)
app.post('/api/abort-elaboration', (req, res) => {
    GLOBAL_ELAB_ABORTED = true;
    setElabPhase('STOP richiesto da UI');
    markElabActivity();
    abortActiveAiRequests();
    console.log('[VISION] Richiesto ABORT globale elaborazione (STOP da UI).');
    sendElabTelegramStatus('stop').catch(function (_) {});
    res.json({ success: true });
});

function defaultFolderSettings() {
    return {
        validity_hours: 48,
        emwa_lookback_hours: 168, // 24h=24, 72h=72, 7gg=168, 15gg=360, 20gg=480, 30gg=720 — articoli più vecchi non considerati per EMWA_Pesato
        analyze_max_concurrent: 1,
        json_update_every: 0, // Aggiornamento automatico EMWA/Articoli_riassunto: 0=OFF, altrimenti 10/20/50/100 articoli
        batch_wait_minutes: 0,
        email_progressivo: 0,
        debug_one_article: false,
        only_search_phase: false,
        log_show_questions: false,
        log_show_responses: false,
        use_emwa_params: false,
        auto_send_email: false,
        telegram_elab_report_enabled: false,
        force_sintesi_each_valid: false
        // url_list_settings: settaggi della lista (es. activeByUrl), non la lista stessa
    };
}

function normalizeFolderSettings(input) {
    var out = defaultFolderSettings();
    var src = (input && typeof input === 'object') ? input : {};

    var vh = parseInt(src.validity_hours, 10);
    if ([24, 48, 72, 168, 360, 480, 720].indexOf(vh) !== -1) out.validity_hours = vh;

    var emwaH = parseInt(src.emwa_lookback_hours, 10);
    if ([24, 48, 72, 168, 360, 480, 720].indexOf(emwaH) !== -1) out.emwa_lookback_hours = emwaH;

    var mc = parseInt(src.analyze_max_concurrent, 10);
    if ([1, 10, 50, 100, 150].indexOf(mc) !== -1) out.analyze_max_concurrent = mc;

    var ju = parseInt(src.json_update_every, 10);
    if ([0, 10, 20, 50, 100].indexOf(ju) !== -1) out.json_update_every = ju;

    var bwm = parseInt(src.batch_wait_minutes, 10);
    // Compatibilità con vecchio valore "10" (era usato per 1 minuto)
    if (bwm === 10) bwm = 1;
    // Stessa whitelist della UI (ALLOWED_BATCH_WAIT_MINUTES in script.js)
    if ([0, 1, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720].indexOf(bwm) !== -1) {
        out.batch_wait_minutes = bwm;
    }

    var ep = parseInt(src.email_progressivo, 10);
    if (!isNaN(ep) && ep >= 0) out.email_progressivo = ep;

    out.debug_one_article = !!src.debug_one_article;
    out.only_search_phase = !!src.only_search_phase;
    out.log_show_questions = !!src.log_show_questions;
    out.log_show_responses = !!src.log_show_responses;
    out.use_emwa_params = !!src.use_emwa_params;
    out.force_deepseek_chat = !!src.force_deepseek_chat;
    out.auto_send_email = !!src.auto_send_email;
    out.telegram_elab_report_enabled = !!src.telegram_elab_report_enabled;
    out.force_sintesi_each_valid = !!src.force_sintesi_each_valid;
    out.force_reprocess_existing = !!src.force_reprocess_existing;

    if (src.url_list_settings && typeof src.url_list_settings === 'object' && !Array.isArray(src.url_list_settings)) {
        out.url_list_settings = src.url_list_settings;
    }

    return out;
}

function getUseEmwaParamsFromFolderSettings() {
    var raw = readJsonObject(FOLDER_SETTINGS_FILE, null);
    var settings = normalizeFolderSettings(raw);
    return !!(settings && settings.use_emwa_params);
}

function getTelegramElabReportEnabledFromFolderSettings() {
    var raw = readJsonObject(FOLDER_SETTINGS_FILE, null);
    var settings = normalizeFolderSettings(raw);
    return !!(settings && settings.telegram_elab_report_enabled);
}

function getForceDeepseekChatFromFolderSettings() {
    var raw = readJsonObject(FOLDER_SETTINGS_FILE, null);
    var settings = normalizeFolderSettings(raw);
    return !!(settings && settings.force_deepseek_chat);
}

function getSharedQuestionDataset() {
    var useEmwa = getUseEmwaParamsFromFolderSettings();
    var articoli = readJson(ARTICOLI_RIASSUNTO_FILE);
    if (!Array.isArray(articoli)) articoli = [];
    if (useEmwa) {
        var emwa = readJsonObject(NAZIONI_ELABORATE_PESATO_SOMMATO_FILE, {});
        if (!emwa || typeof emwa !== 'object' || Array.isArray(emwa)) emwa = {};
        return {
            key: 'Articoli_riassunto + EMWA_Pesato_Sommato',
            file: 'Articoli_riassunto.json + EMWA_Pesato_Sommato.json',
            data: {
                Articoli_riassunto: articoli,
                EMWA_Pesato_Sommato: emwa
            }
        };
    } else {
        return {
            key: 'Articoli_riassunto',
            file: 'Articoli_riassunto.json',
            data: articoli
        };
    }
}

// Elenco unico delle nazioni presenti in sintesi_EMWA_Pesato_Sommato.json e negli articoli (articolielaborati → Articoli_riassunto)
function getUniqueNazioniListForQuestionNote() {
    var set = Object.create(null);
    try {
        var dataSintesi = readJsonObject(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE, null);
        var parsed = parseSintesiResponseFromIA(dataSintesi);
        var byNation = parsed.byNation || {};
        for (var n in byNation) { if (byNation.hasOwnProperty(n) && n) set[n] = true; }
    } catch (e) { /* ignora */ }
    try {
        var arr = readJson(ARTICOLI_ELABORATI_FILE);
        if (!Array.isArray(arr)) arr = [];
        for (var i = 0; i < arr.length; i++) {
            var entry = arr[i];
            if (!entry || typeof entry !== 'object') continue;
            var notizia = (typeof entry.notizia === 'string' ? entry.notizia : '').trim();
            if (!notizia) continue;
            var objs = extractNationObjectsFromEntry(entry);
            for (var j = 0; j < objs.length; j++) {
                var nn = objs[j] && objs[j].nazione ? String(objs[j].nazione).trim() : '';
                if (nn) set[nn] = true;
            }
        }
    } catch (e) { /* ignora */ }
    var list = Object.keys(set).filter(Boolean).sort();
    return list;
}

// Escape per messaggi Telegram in HTML (evita tag malformati)
function escapeTelegramHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Spezza un testo HTML in chunk <= maxLen per limite Telegram (4096)
function chunkTelegramHtml(html, maxLen) {
    maxLen = (typeof maxLen === 'number' && maxLen > 0) ? maxLen : 4090;
    if (html.length <= maxLen) return [html];
    var chunks = [];
    var rest = html;
    while (rest.length > 0) {
        if (rest.length <= maxLen) {
            chunks.push(rest);
            break;
        }
        var slice = rest.substring(0, maxLen);
        var lastNewline = slice.lastIndexOf('\n');
        if (lastNewline > maxLen / 2) {
            chunks.push(rest.substring(0, lastNewline + 1));
            rest = rest.substring(lastNewline + 1);
        } else {
            chunks.push(slice);
            rest = rest.substring(maxLen);
        }
    }
    return chunks;
}

// Percorso Chrome/Chromium di sistema (se Puppeteer non ha il browser bundled)
function getChromeExecutablePath() {
    var fromEnv = (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    var paths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ];
    for (var i = 0; i < paths.length; i++) {
        if (fs.existsSync(paths[i])) return paths[i];
    }
    return null;
}

// Render HTML (email template) to PNG buffer per invio Telegram come screenshot. Richiede puppeteer.
async function renderHtmlToPng(html) {
    var browser;
    try {
        var puppeteer = require('puppeteer');
        var launchOpts = {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        };
        var exe = getChromeExecutablePath();
        if (exe) launchOpts.executablePath = exe;
        browser = await puppeteer.launch(launchOpts);
        var page = await browser.newPage();
        await page.setViewport({ width: 620, height: 800, deviceScaleFactor: 2 });
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 10000 });
        await page.evaluate(function () { document.body.style.background = '#0b0b0a'; });
        var buffer = await page.screenshot({ type: 'png', fullPage: true });
        await browser.close();
        return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    } catch (e) {
        if (browser) try { await browser.close(); } catch (_) {}
        throw e;
    }
}

// Lista destinatari report: Json/email-recipients.json (array di { address, type, active, alias } o legacy { email, active }).
// Restituisce oggetto con liste distinte per email e Telegram.
function getEmailRecipientsList() {
    var emailRecipients = [];
    var telegramRecipients = [];
    try {
        var data = readJson(EMAIL_RECIPIENTS_FILE);
        if (Array.isArray(data) && data.length > 0) {
            data.forEach(function (r) {
                if (!r || typeof r !== 'object') return;
                var addr = '';
                if (r.address != null) addr = String(r.address).trim();
                else if (r.email != null) addr = String(r.email).trim();
                if (!addr) return;
                if (r.active === false) return;
                var alias = '';
                if (r.alias != null) alias = String(r.alias).trim();
                var type = r.type ? String(r.type).toLowerCase() : '';
                if (!type) {
                    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
                        type = 'email';
                    } else if (/^@[\w_]+$/.test(addr) || /^tg:/i.test(addr) || /^telegram:/i.test(addr) || /^-?\d+$/.test(addr)) {
                        type = 'telegram';
                    } else {
                        type = 'email';
                    }
                }
                if (type === 'telegram') telegramRecipients.push({ address: addr, alias: alias });
                else emailRecipients.push({ address: addr, alias: alias });
            });
        }
    } catch (e) { /* ignora */ }
    if (emailRecipients.length === 0 && telegramRecipients.length === 0 && EMAIL_RECIPIENTS.length > 0) {
        emailRecipients = EMAIL_RECIPIENTS.map(function (addr) {
            return { address: addr, alias: '' };
        });
    }
    return { emailRecipients: emailRecipients, telegramRecipients: telegramRecipients };
}

app.get('/api/email-recipients', (req, res) => {
    try {
        var data = readJson(EMAIL_RECIPIENTS_FILE);
        if (!Array.isArray(data)) data = [];
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/email-recipients', (req, res) => {
    try {
        var list = req.body && req.body.list;
        if (!Array.isArray(list)) return res.status(400).json({ error: 'body.list richiesto (array)' });
        var out = list.map(function (item) {
            if (!item || typeof item !== 'object') return null;
            var addr = '';
            if (item.address != null) addr = String(item.address).trim();
            else if (item.email != null) addr = String(item.email).trim();
            if (!addr) return null;
            var type = item.type ? String(item.type).toLowerCase() : '';
            if (!type) {
                if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
                    type = 'email';
                } else if (/^@[\w_]+$/.test(addr) || /^tg:/i.test(addr) || /^telegram:/i.test(addr) || /^-?\d+$/.test(addr)) {
                    type = 'telegram';
                } else {
                    type = 'email';
                }
            }
            var active = item && item.active !== false;
            var alias = item && item.alias != null ? String(item.alias).trim() : '';
            return { address: addr, type: type, active: !!active, alias: alias };
        }).filter(function (item) { return item && item.address !== ''; });
        var ok = writeJson(EMAIL_RECIPIENTS_FILE, out);
        if (!ok) return res.status(500).json({ error: 'Impossibile scrivere email-recipients.json' });
        res.json({ success: true, list: out });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/folder-settings', (req, res) => {
    try {
        var raw = readJsonObject(FOLDER_SETTINGS_FILE, null);
        var settings = normalizeFolderSettings(raw);
        res.json({
            active: activeJsonSubdir || '',
            settings: settings
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/folder-settings', async (req, res) => {
    try {
        var settings = normalizeFolderSettings(req.body || {});
        var ok = await writeJsonSerialized(FOLDER_SETTINGS_FILE, settings);
        if (!ok) return res.status(500).json({ error: 'Impossibile salvare impostazioni cartella' });
        res.json({
            success: true,
            active: activeJsonSubdir || '',
            settings: settings
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Get Logs
app.get('/api/logs', (req, res) => {
    res.json(serverLogs);
    serverLogs = []; // Clear logs after sending
});
const readJson = (file) => {
    if (!fs.existsSync(file)) return [];
    try {
        var s = fs.readFileSync(file, 'utf8');
        if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
        return JSON.parse(s.trim());
    } catch (e) {
        console.error('Error reading ' + file + ':', e.message);
        return [];
    }
};

function writeJsonDirect(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error("Error writing " + file + ":", e.message);
        return false;
    }
}

// Scritture serializzate per file "caldi" (settings/sintesi/note/questions)
const hotFileWriteQueues = new Map();
function isHotFileForSerializedWrite(file) {
    var base = String(path.basename(file || '')).toLowerCase();
    if (!base) return false;
    if (base === 'folder-settings.json') return true;
    if (base === 'questions.json') return true;
    if (base === 'note.json') return true;
    if (base.indexOf('sintesi') === 0) return true;
    return false;
}

function enqueueSerializedFileOp(file, op) {
    var key = String(path.resolve(file));
    var prev = hotFileWriteQueues.get(key) || Promise.resolve();
    var next = prev.then(function () {
        return op();
    }).catch(function (e) {
        console.error('enqueueSerializedFileOp error (' + file + '):', e.message);
        return false;
    });
    hotFileWriteQueues.set(key, next);
    return next.finally(function () {
        if (hotFileWriteQueues.get(key) === next) hotFileWriteQueues.delete(key);
    });
}

function writeJsonSerialized(file, data) {
    if (!isHotFileForSerializedWrite(file)) return Promise.resolve(writeJsonDirect(file, data));
    return enqueueSerializedFileOp(file, function () {
        return writeJsonDirect(file, data);
    });
}

function writeTextSerialized(file, text) {
    var out = text != null ? String(text) : '';
    if (!isHotFileForSerializedWrite(file)) {
        fs.writeFileSync(file, out, 'utf8');
        return Promise.resolve(true);
    }
    return enqueueSerializedFileOp(file, function () {
        fs.writeFileSync(file, out, 'utf8');
        return true;
    });
}

function writeJson(file, data) {
    return writeJsonDirect(file, data);
}

function appendJsonArrayEntry(file, entry) {
    try {
        if (isHotFileForSerializedWrite(file)) {
            enqueueSerializedFileOp(file, function () {
                var arrHot = readJson(file);
                if (!Array.isArray(arrHot)) arrHot = [];
                arrHot.push(entry);
                return writeJsonDirect(file, arrHot);
            });
            return;
        }
        var arr = readJson(file);
        if (!Array.isArray(arr)) arr = [];
        arr.push(entry);
        writeJson(file, arr);
    } catch (e) {
        console.error('appendJsonArrayEntry error (' + file + '):', e.message);
    }
}

function appendQuestionTextBlock(stage, requestText, responseText) {
    var section = '======================';
    var divider = '_________________________';
    var title = stage != null ? String(stage) : 'Question_unknown';
    var req = requestText != null ? String(requestText) : '';
    var res = responseText != null ? String(responseText) : '';
    var block = [
        divider,
        section,
        title,
        section,
        req,
        section,
        res,
        section,
        ''
    ].join('\n');
    return enqueueSerializedFileOp(QUESTIONS_FILE, function () {
        var current = '';
        try {
            if (fs.existsSync(QUESTIONS_FILE)) current = fs.readFileSync(QUESTIONS_FILE, 'utf8');
        } catch (_) {}
        var trimmed = String(current || '').trim();
        if (!trimmed || trimmed === '[]' || trimmed === '{}') {
            fs.writeFileSync(QUESTIONS_FILE, block, 'utf8');
        } else {
            fs.appendFileSync(QUESTIONS_FILE, '\n' + block, 'utf8');
        }
        return true;
    });
}

function recordQuestion(stage, requestText, responseText, meta) {
    var s = stage || 'Question_unknown';
    var req = requestText != null ? String(requestText) : '';
    if (meta && typeof meta === 'object' && typeof meta.system === 'string' && meta.system.trim()) {
        if (req) req = meta.system + '\n\n' + req;
        else req = meta.system;
    }
    var res = responseText != null ? String(responseText) : '';
    if (s !== 'ai_chat') {
        elabStatus.lastAiResponseAt = Date.now();
        elabStatus.lastAiResponseStage = s;
        elabStatus.lastAiResponsePreview = res;
        if (elabStatus.running) markElabActivity();
    }
    appendQuestionTextBlock(s, req, res);
}

function recordScartato(title, url, reason, meta, author) {
    var metaObj = meta && typeof meta === 'object' ? meta : {};
    var entry = {
        timestamp: new Date().toISOString(),
        // Mantieni sia title/url che titolo/link per compatibilità,
        // ma usa la stessa struttura logica di Accettati.
        title: title || null,
        titolo: title || null,
        url: url || null,
        link: url || null,
        reason: reason || 'scartato',
        meta: metaObj
    };
    if (author && typeof author === 'string' && author.trim()) {
        entry.author = author.trim();
    }
    // Non duplicare la nota a livello top-level: resta in meta.nota
    // (la UI la legge comunque da sc0.nota || sc0.meta.nota).
    appendScartatiSerialized(entry);
}

// Coda serializzata per errori.json (evita race con N richieste concorrenti)
var erroriWriteQueue = Promise.resolve();
function appendErroreSerialized(entry) {
    erroriWriteQueue = erroriWriteQueue.then(function () {
        try {
            var list = readJson(ERRORI_FILE);
            if (!Array.isArray(list)) list = [];
            list.push(entry);
            writeJson(ERRORI_FILE, list);
        } catch (e) {
            console.error('appendErroreSerialized error:', e.message);
        }
    }).catch(function (e) {
        console.error('erroriWriteQueue rejected:', e && e.message ? e.message : e);
    });
}

function readJsonObject(file, defaultVal) {
    if (!fs.existsSync(file)) return defaultVal;
    try {
        var s = fs.readFileSync(file, 'utf8');
        if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
        var out = JSON.parse(s.trim());
        return typeof out === 'object' && out !== null ? out : defaultVal;
    } catch (e) {
        console.error('Error reading ' + file + ':', e.message);
        // Auto-ripristino per file JSON critici se corrotti/troncati
        try {
            if (file === NOTE_FILE) {
                var safeNotes = { byNation: {}, byCode: {} };
                fs.writeFileSync(file, JSON.stringify(safeNotes, null, 2), 'utf8');
                console.warn('[VISION] note.json corrotto: ripristinato a struttura vuota.');
                return safeNotes;
            }
        } catch (_) {}
        return defaultVal;
    }
}

// Coda serializzata per articolielaborati.json (evita race con N richieste concorrenti)
var articoliElaboratiWriteQueue = Promise.resolve();
function appendArticoloElaborato(entry) {
    articoliElaboratiWriteQueue = articoliElaboratiWriteQueue.then(function () {
    try {
        var arr = readJson(ARTICOLI_ELABORATI_FILE);
        if (!Array.isArray(arr)) arr = [];
        arr.push(entry);
        var ok = writeJson(ARTICOLI_ELABORATI_FILE, arr);
        if (ok) {
            console.log("Scritto su articolielaborati.json (entry " + arr.length + ") -> " + ARTICOLI_ELABORATI_FILE);
        } else {
            console.error("Scrittura articolielaborati.json FALLITA");
        }
    } catch (e) {
        console.error("appendArticoloElaborato error:", e.message);
    }
    });
    return articoliElaboratiWriteQueue;
}

function isArticoloElaboratoValidEntry(entry) {
    var r = entry && entry.response;
    var hasNotizia = !!(entry && typeof entry.notizia === 'string' && entry.notizia.trim());
    return Array.isArray(r) && r.length > 0 && hasNotizia;
}

async function hasArticoloElaboratoUrl(urlLike) {
    try { await articoliElaboratiWriteQueue; } catch (_) {}
    var key = normalizeArticleUrlKey(urlLike);
    if (!key) return false;
    var arr = readJson(ARTICOLI_ELABORATI_FILE);
    if (!Array.isArray(arr) || arr.length === 0) return false;
    for (var i = 0; i < arr.length; i++) {
        var it = arr[i] || {};
        if (!isArticoloElaboratoValidEntry(it)) continue;
        var existingKey = normalizeArticleUrlKey(it.url || '');
        if (existingKey && existingKey === key) return true;
    }
    return false;
}

// Coda serializzata per Accettati.json (evita race con N richieste concorrenti)
var accettatiWriteQueue = Promise.resolve();
function appendAccettatiSerialized(titolo, link, nota, author) {
    var nowIso = new Date().toISOString();
    accettatiWriteQueue = accettatiWriteQueue.then(function () {
        try {
            var accettati = readJson(ACCETTATI_FILE);
            if (!Array.isArray(accettati)) accettati = [];
            var idx = -1;
            for (var i = 0; i < accettati.length; i++) {
                var it = accettati[i] || {};
                if ((it.link || null) === (link || null)) {
                    idx = i;
                    break;
                }
            }
            if (idx === -1) {
                var entry = { titolo: titolo || null, link: link || null, timestamp: nowIso };
                if (typeof nota === 'string' && nota.trim()) entry.nota = nota.trim();
                if (author && typeof author === 'string' && author.trim()) entry.author = author.trim();
                accettati.push(entry);
            } else {
                var existing = accettati[idx] || {};
                if (titolo && !existing.titolo) existing.titolo = titolo;
                if (link && !existing.link) existing.link = link;
                existing.timestamp = nowIso;
                if (typeof nota === 'string' && nota.trim() && !existing.nota) {
                    existing.nota = nota.trim();
                }
                if (author && typeof author === 'string' && author.trim() && !existing.author) {
                    existing.author = author.trim();
                }
                accettati[idx] = existing;
            }
            writeJson(ACCETTATI_FILE, accettati);
            console.log("[VISION] Scritto Accettati.json (totale " + accettati.length + ")");
        } catch (e) {
            console.error('Scrittura Accettati.json:', e.message);
        }
    });
    return accettatiWriteQueue;
}

// Link secondari (es. link trovati dentro post Telegram)
function readLinkSecondari() {
    var arr = readJson(LINK_SECONDARI_FILE);
    if (!Array.isArray(arr)) arr = [];
    return arr;
}

function isYouTubeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    var u = url.trim().toLowerCase();
    return u.indexOf('youtube.com') !== -1 || u.indexOf('youtu.be') !== -1;
}

function addLinkSecondario(url, date) {
    if (!url || typeof url !== 'string') return false;
    url = url.trim();
    if (!url) return false;
    if (isYouTubeUrl(url)) return true;
    var arr = readLinkSecondari();
    if (arr.some(function (e) { return e && e.url === url; })) return true;
    arr.push({ url: url, date: date || null });
    return writeJson(LINK_SECONDARI_FILE, arr);
}

// Verifica se un titolo indica la necessità di forzare il controllo trascrizione
// (utilizzato per video YouTube senza titolo o con titolo generico)
function isForcedTranscriptCheck(title) {
    return title && typeof title === 'string' && title.indexOf('FORCE_TRANSCRIPT_CHECK:') === 0;
}

// API: elenco articoli accettati
app.get('/api/accettati', (req, res) => {
    res.json(readJson(ACCETTATI_FILE));
});

// API: elenco articoli scartati
app.get('/api/scartati', (req, res) => {
    res.json(readJson(SCARTATI_FILE));
});

// API: elenco errori IA (errori.json)
app.get('/api/errori', (req, res) => {
    res.json(readJson(ERRORI_FILE));
});

// API: rimuovi da Scartati tutte le entry con URL YouTube (watch); così i video possono essere rielaborati
app.post('/api/clear-scartati-youtube', (req, res) => {
    try {
        var scartati = readJson(SCARTATI_FILE);
        if (!Array.isArray(scartati)) scartati = [];
        var before = scartati.length;
        var isYoutubeUrl = function (urlStr) {
            if (!urlStr || typeof urlStr !== 'string') return false;
            var u = (urlStr || '').trim();
            return u.indexOf('youtube.com/watch') !== -1 || u.indexOf('youtu.be/') !== -1;
        };
        scartati = scartati.filter(function (entry) {
            var url = (entry && (entry.url || entry.link)) || '';
            return !isYoutubeUrl(url);
        });
        var removed = before - scartati.length;
        writeJson(SCARTATI_FILE, scartati);
        console.log('[VISION] clear-scartati-youtube: rimossi ' + removed + ' video YouTube da Scartati (restano ' + scartati.length + ' entry).');
        res.json({ success: true, removed: removed, remaining: scartati.length });
    } catch (e) {
        console.error('clear-scartati-youtube:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// API: elenco articoli raccolti (articles.json)
app.get('/api/articles', (req, res) => {
    res.json(readJson(ARTICLES_FILE));
});

// API: stato sintetico IA + range date (da EMWA_Pesato.json)
app.get('/api/status-ai', (req, res) => {
    try {
        // Range date da EMWA_Pesato.json:
        // struttura: { Nazione: { parametro: [ { valore, peso, data }, ... ], ... }, ... }
        var emwa = readJsonObject(NAZIONI_ELABORATE_PESATO_FILE, {});
        if (!emwa || typeof emwa !== 'object' || Array.isArray(emwa)) emwa = {};
        var minMs = null;
        var maxMs = null;
        Object.keys(emwa).forEach(function (nation) {
            var perNation = emwa[nation];
            if (!perNation || typeof perNation !== 'object' || Array.isArray(perNation)) return;
            Object.keys(perNation).forEach(function (param) {
                var series = perNation[param];
                if (!Array.isArray(series)) return;
                for (var i = 0; i < series.length; i++) {
                    var item = series[i] || {};
                    var rawDate = item.data || null; // atteso formato YYYY-MM-DD
                    if (!rawDate) continue;
                    var ms = parseDateMs(rawDate);
                    if (isNaN(ms)) continue;
                    if (minMs === null || ms < minMs) minMs = ms;
                    if (maxMs === null || ms > maxMs) maxMs = ms;
                }
            });
        });
        // Se EMWA_Pesato non è disponibile o vuoto, min/max restano null e il frontend mostrerà stringa vuota.
        var minDate = minMs != null ? new Date(minMs).toISOString() : null;
        var maxDate = maxMs != null ? new Date(maxMs).toISOString() : null;
        // Articoli nel periodo di retroelaborazione: usa lookback da query (UI) o da folder-settings
        var rawSettings = readJsonObject(FOLDER_SETTINGS_FILE, null);
        var settings = normalizeFolderSettings(rawSettings);
        var lookbackH = (req.query && req.query.emwa_lookback_hours != null)
            ? parseInt(req.query.emwa_lookback_hours, 10)
            : (settings && typeof settings.emwa_lookback_hours === 'number' ? settings.emwa_lookback_hours : 168);
        if (![24, 48, 72, 168, 360, 480, 720].includes(lookbackH)) lookbackH = 168;
        var riassuntoCount = getArticolielaboratiCountInLookback(lookbackH);
        // Numero agenti: leggi sempre il valore persistito in folder-settings
        var maxAgentsPersisted = settings && typeof settings.analyze_max_concurrent === 'number'
            ? settings.analyze_max_concurrent
            : 1;
        res.json({
            riassuntoMinDate: minDate,
            riassuntoMaxDate: maxDate,
            riassuntoCount: riassuntoCount,
            activeAgents: analyzeArticleConcurrent,
            maxAgents: maxAgentsPersisted
        });
    } catch (e) {
        console.error('status-ai error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// API: link secondari (GET: lista, POST/add: aggiunge singolo link)
app.get('/api/link-secondari', (req, res) => {
    res.json(readLinkSecondari());
});

app.post('/api/link-secondari/add', (req, res) => {
    try {
        var body = req.body || {};
        var url = body.url != null ? String(body.url).trim() : '';
        var date = body.date != null ? String(body.date).trim() : null;
        if (!url) return res.status(400).json({ success: false, error: 'url mancante' });
        var ok = addLinkSecondario(url, date);
        if (!ok) return res.status(500).json({ success: false, error: 'Impossibile scrivere link_secondari.json' });
        res.json({ success: true });
    } catch (e) {
        console.error('link-secondari/add error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Coda serializzata per Scartati.json (evita race con N richieste concorrenti)
var scartatiWriteQueue = Promise.resolve();
function appendScartatiSerialized(entry) {
    scartatiWriteQueue = scartatiWriteQueue.then(function () {
        try {
            var scartati = readJson(SCARTATI_FILE);
            if (!Array.isArray(scartati)) scartati = [];
            var entryUrlKey = normalizeArticleUrlKey(entry && entry.url ? entry.url : '');
            var duplicateIdx = -1;
            if (entryUrlKey) {
                for (var i = 0; i < scartati.length; i++) {
                    var it = scartati[i] || {};
                    var itKey = normalizeArticleUrlKey(it.url || it.link || '');
                    if (itKey && itKey === entryUrlKey) {
                        duplicateIdx = i;
                        break;
                    }
                }
            }
            if (duplicateIdx >= 0) {
                var prev = scartati[duplicateIdx] || {};
                prev.timestamp = (entry && entry.timestamp) ? entry.timestamp : (new Date().toISOString());
                if ((!prev.title || !String(prev.title).trim()) && entry && entry.title) prev.title = entry.title;
                if ((!prev.reason || !String(prev.reason).trim()) && entry && entry.reason) prev.reason = entry.reason;
                if ((!prev.nota || !String(prev.nota).trim()) && entry && entry.nota) prev.nota = entry.nota;
                if (entry && entry.meta && typeof entry.meta === 'object') {
                    prev.meta = Object.assign({}, prev.meta || {}, entry.meta);
                }
                scartati[duplicateIdx] = prev;
                console.log("[VISION] Scartati duplicate skip (gia presente): " + (entry && entry.url ? entry.url : 'n/d'));
            } else {
            scartati.push(entry);
            }
            writeJson(SCARTATI_FILE, scartati);
            console.log("[VISION] Scritto Scartati.json (totale " + scartati.length + ")");
        } catch (e) {
            console.error('Scrittura Scartati.json:', e.message);
        }
    });
    return scartatiWriteQueue;
}

// API: Get articolielaborati.json
app.get('/api/articolielaborati', (req, res) => {
    res.json(readJson(ARTICOLI_ELABORATI_FILE));
});

// Conta le entry valide (response = array nazioni, non oggetto con error)
function getValidArticolielaboratiCount() {
    var arr = readJson(ARTICOLI_ELABORATI_FILE);
    if (!Array.isArray(arr)) return 0;
    var n = 0;
    for (var i = 0; i < arr.length; i++) {
        var r = arr[i] && arr[i].response;
        if (r && Array.isArray(r) && r.length > 0) n++;
    }
    return n;
}

// Conta articolielaborati validi con data entro il lookback (ore). Usato per "Articoli : N" in base al tempo di retroelaborazione.
function getArticolielaboratiCountInLookback(lookbackHours) {
    var arr = readJson(ARTICOLI_ELABORATI_FILE);
    if (!Array.isArray(arr)) return 0;
    var cutoffMs = Date.now() - (lookbackHours * 60 * 60 * 1000);
    var n = 0;
    for (var i = 0; i < arr.length; i++) {
        var entry = arr[i];
        if (!entry || typeof entry !== 'object') continue;
        var r = entry.response;
        if (!r || !Array.isArray(r) || r.length === 0) continue;
        var rawDate = entry.article_date || entry.Data || entry.data || null;
        var ms = parseDateMs(rawDate);
        if (isNaN(ms)) continue;
        if (ms < cutoffMs) continue;
        n++;
    }
    return n;
}

// API: conteggio articolielaborati validi
app.get('/api/articolielaborati-count', (req, res) => {
    res.json({ count: getValidArticolielaboratiCount() });
});

// Da una entry di articolielaborati.json estrae array di { nazione, params }. response è il JSON restituito dall'IA.
function extractNationObjectsFromEntry(entry) {
    var objs = [];
    if (!entry || !entry.response) return objs;
    var r = entry.response;
    if (Array.isArray(r)) {
        for (var i = 0; i < r.length; i++) {
            var o = r[i];
            if (o && o.nazione) {
                var nazione = nations.getCanonicalNameIfValid ? nations.getCanonicalNameIfValid(String(o.nazione)) : String(o.nazione).trim();
                if (!nazione) continue;
                var params = {};
                for (var k in o) {
                    if (k === 'nazione' || k === 'commento') continue;
                    if (typeof o[k] === 'number') params[k] = o[k];
                }
                objs.push({ nazione: nazione, params: params });
            }
        }
        return objs;
    }
    if (r && typeof r === 'object' && r.nazione) {
        var n = nations.getCanonicalNameIfValid ? nations.getCanonicalNameIfValid(String(r.nazione)) : String(r.nazione).trim();
        if (n) {
            var p = {};
            for (var key in r) {
                if (key === 'nazione' || key === 'commento') continue;
                if (typeof r[key] === 'number') p[key] = r[key];
            }
            objs.push({ nazione: n, params: p });
        }
    }
    return objs;
}

// Legacy: estrae da stringa raw (se response era salvato come stringa)
function extractNationObjectsFromString(raw) {
    var objs = [];
    if (typeof raw !== 'string') return objs;
    try {
        var blockRe = /```\s*json\s*([\s\S]*?)```/gi;
        var blockMatch;
        while ((blockMatch = blockRe.exec(raw)) !== null) {
            var inner = (blockMatch[1] || '').trim();
            try {
                var parsed = JSON.parse(inner);
                if (Array.isArray(parsed)) objs = objs.concat(parsed); else if (parsed && parsed.nazione) objs.push(parsed);
            } catch (_) {}
        }
        if (objs.length === 0) {
            var idx = 0;
            while ((idx = raw.indexOf('[', idx)) !== -1) {
                var depth = 0, start = idx, inStr = false, strCh = '';
                for (var j = idx; j < raw.length; j++) {
                    var c = raw[j];
                    if (!inStr) {
                        if (c === '[') depth++;
                        else if (c === ']') { depth--; if (depth === 0) { try { var arr = JSON.parse(raw.substring(start, j + 1)); if (Array.isArray(arr) && arr.length > 0 && arr[0] && arr[0].nazione) objs = objs.concat(arr); } catch (_) {} break; } }
                        else if ((c === '"' || c === "'") && (j === 0 || raw[j - 1] !== '\\')) { inStr = true; strCh = c; }
                    } else if (c === strCh && (j === 0 || raw[j - 1] !== '\\')) inStr = false;
                }
                idx++;
            }
        }
        if (objs.length === 0) {
            try {
                var direct = JSON.parse(raw);
                if (Array.isArray(direct)) objs = direct; else if (direct && direct.nazione) objs = [direct];
            } catch (_) {}
        }
    } catch (_) {}
    return objs;
}

// Aggrega articolielaborati: per ogni nazione, P = 0.6×max(v) + 0.4×media(v) per ogni parametro
function computeNazioniAggregate() {
    var arr = readJson(ARTICOLI_ELABORATI_FILE);
    if (!Array.isArray(arr)) arr = [];
    var objs = [];
    for (var i = 0; i < arr.length; i++) objs = objs.concat(extractNationObjectsFromEntry(arr[i]));
    var agg = {}; // { nazione: { param: { sum, count, max } } }
    for (var k = 0; k < objs.length; k++) {
        var o = objs[k];
        if (!o || !o.nazione || !o.params) continue;
        if (typeof o.params.importanza_di_questo_articolo !== 'number') continue;
        var imp = o.params.importanza_di_questo_articolo;
        if (imp <= 30) continue;
        var nazione = o.nazione;
        if (!agg[nazione]) agg[nazione] = {};
        for (var key in o.params) {
            if (!o.params.hasOwnProperty(key) || typeof o.params[key] !== 'number') continue;
            if (!agg[nazione][key]) agg[nazione][key] = { sum: 0, count: 0, max: -Infinity };
            var v = o.params[key];
            agg[nazione][key].sum += v;
            agg[nazione][key].count += 1;
            if (v > agg[nazione][key].max) agg[nazione][key].max = v;
        }
    }
    var result = {};
    for (var n in agg) {
        if (!agg.hasOwnProperty(n)) continue;
        result[n] = {};
        for (var p in agg[n]) {
            if (!agg[n].hasOwnProperty(p)) continue;
            var s = agg[n][p].sum, c = agg[n][p].count, mx = agg[n][p].max;
            var media = c > 0 ? s / c : 0;
            var P = c > 0 ? 0.6 * mx + 0.4 * media : 0;
            result[n][p] = Math.round(P * 100) / 100;
        }
    }
    return result;
}

function round2(num) {
    return Math.round(num * 100) / 100;
}

function parseDateMs(val) {
    if (!val) return NaN;
    var ms = Date.parse(val);
    return isNaN(ms) ? NaN : ms;
}

// Estrae un valore numerico "importanza articolo" da una entry (max di importanza_di_questo_articolo in response) per ordinamento.
function getImportanzaArticoloFromEntry(entry) {
    if (!entry || !entry.response) return 0;
    var r = entry.response;
    var maxImp = 0;
    if (Array.isArray(r)) {
        for (var i = 0; i < r.length; i++) {
            var v = r[i] && typeof r[i].importanza_di_questo_articolo === 'number' ? r[i].importanza_di_questo_articolo : 0;
            if (v > maxImp) maxImp = v;
        }
        return maxImp;
    }
    if (r && typeof r === 'object' && typeof r.importanza_di_questo_articolo === 'number') return r.importanza_di_questo_articolo;
    return 0;
}

// Riordina articolielaborati.json per Data crescente, poi importanza articolo crescente; riscrive il file.
function sortArticolielaboratiByDateAndImportanza() {
    try {
        var arr = readJson(ARTICOLI_ELABORATI_FILE);
        if (!Array.isArray(arr) || arr.length === 0) return;
        arr.sort(function (a, b) {
            var da = parseDateMs(a.article_date || a.Data || a.data || null);
            var db = parseDateMs(b.article_date || b.Data || b.data || null);
            if (isNaN(da)) da = Number.MAX_SAFE_INTEGER;
            if (isNaN(db)) db = Number.MAX_SAFE_INTEGER;
            if (da !== db) return da - db;
            var impA = getImportanzaArticoloFromEntry(a);
            var impB = getImportanzaArticoloFromEntry(b);
            return impA - impB;
        });
        var ok = writeJson(ARTICOLI_ELABORATI_FILE, arr);
        if (ok) console.log('[VISION] articolielaborati.json riordinato per Data e importanza articolo (crescente).');
    } catch (e) {
        console.error('sortArticolielaboratiByDateAndImportanza error:', e.message);
    }
}

// Genera Articoli_riassunto.json da articolielaborati.json: per ogni articolo notizia, peso notizia (importanza_di_questo_articolo), Data.
// Applica lo stesso filtro di Tempo di retroelaborazione (emwa_lookback_hours) usato per EMWA_Pesato: articoli più vecchi vengono esclusi.
// In ogni caso, per stabilità e coerenza con EMWA_Pesato, gli articoli effettivamente usati NON superano mai una soglia massima (es. 333).
function buildAndWriteArticoliRiassunto() {
    try {
        var raw = readJson(ARTICOLI_ELABORATI_FILE);
        var arr = [];
        if (Array.isArray(raw)) {
            arr = raw;
            // Se il file è salvato come array annidato [[ {...}, {...} ]] trattalo come array piatto
            if (arr.length === 1 && Array.isArray(arr[0])) arr = arr[0];
        } else if (raw && typeof raw === 'object' && Array.isArray(raw.articoli)) {
            arr = raw.articoli;
        } else if (raw && typeof raw === 'object' && Array.isArray(raw.articles)) {
            arr = raw.articles;
        }
        var totalRaw = Array.isArray(arr) ? arr.length : 0;
        // Mappa URL -> autore da Accettati.json (se disponibile)
        var authorsByUrl = {};
        try {
            var acc = readJson(ACCETTATI_FILE);
            if (!Array.isArray(acc)) acc = [];
            for (var ai = 0; ai < acc.length; ai++) {
                var it = acc[ai] || {};
                var link = it.link || null;
                var auth = (typeof it.author === 'string' ? it.author.trim() : '');
                if (link && auth && !authorsByUrl[link]) {
                    authorsByUrl[link] = auth;
                }
            }
        } catch (e) { /* ignora errori lettura Accettati */ }
        var rawSettings = readJsonObject(FOLDER_SETTINGS_FILE, null);
        var settings = normalizeFolderSettings(rawSettings);
        var lookbackHours = (settings && typeof settings.emwa_lookback_hours === 'number') ? settings.emwa_lookback_hours : 168;
        var cutoffMs = Date.now() - (lookbackHours * 60 * 60 * 1000);
        // Prima raccogli tutti gli articoli validi nel lookback, con la loro data in ms,
        // poi ordina per data decrescente e tieni solo i più recenti (MAX_ARTICOLI_ELABORAZIONE).
        var candidates = [];
        for (var i = 0; i < arr.length; i++) {
            var entry = arr[i];
            if (!entry || typeof entry !== 'object') continue;
            var notizia = (typeof entry.notizia === 'string' ? entry.notizia : '').trim();
            if (!notizia) continue;
            var pesoNotizia = getImportanzaArticoloFromEntry(entry);
            var rawDate = entry.article_date || entry.Data || entry.data || null;
            var sourceMs = parseDateMs(rawDate);
            if (isNaN(sourceMs)) sourceMs = Number.MAX_SAFE_INTEGER;
            if (sourceMs < cutoffMs) continue; // articolo più vecchio del tempo di retroelaborazione: non candidato
            var entryAuthor = null;
            if (typeof entry.author === 'string' && entry.author.trim()) {
                entryAuthor = entry.author.trim();
            } else if (entry.url && authorsByUrl[entry.url]) {
                entryAuthor = authorsByUrl[entry.url];
            }
            candidates.push({
                notizia: notizia,
                peso: pesoNotizia,
                rawDate: rawDate,
                ms: sourceMs,
                author: entryAuthor
            });
        }
        // Ordina per data decrescente (articoli più recenti per primi)
        candidates.sort(function (a, b) { return b.ms - a.ms; });
        // Tieni solo i MAX_ARTICOLI_ELABORAZIONE più recenti
        if (candidates.length > MAX_ARTICOLI_ELABORAZIONE) {
            candidates = candidates.slice(0, MAX_ARTICOLI_ELABORAZIONE);
        }
        // Mappa nel formato finale
        var out = candidates.map(function (c) {
            var Data = normalizeArticleDateString(c.rawDate) || '';
            var obj = { notizia: c.notizia, 'peso notizia': c.peso, Data: Data };
            if (c.author) obj.author = c.author;
            return obj;
        });
        writeJson(ARTICOLI_RIASSUNTO_FILE, out);
        lastRiassuntoArticlesStats = {
            totalRaw: totalRaw,
            considered: out.length,
            lookbackHours: lookbackHours,
            generatedAt: new Date().toISOString(),
            maxCap: MAX_ARTICOLI_ELABORAZIONE,
            truncated: (typeof totalRaw === 'number' && totalRaw > out.length)
        };
        console.log('[VISION] Articoli_riassunto.json generato: ' + out.length + ' articoli considerati su ' + totalRaw + ' totali (lookback ' + lookbackHours + 'h).');
    } catch (e) {
        console.error('buildAndWriteArticoliRiassunto error:', e.message);
        // Non sovrascrivere con []: mantieni il file esistente finché non viene rigenerato
    }
}

function buildNazioniElaborateFromArticoli() {
    var arr = readJson(ARTICOLI_ELABORATI_FILE);
    if (!Array.isArray(arr)) arr = [];
    var byNation = {};
    var seq = 0;
    for (var i = 0; i < arr.length; i++) {
        var entry = arr[i] || {};
        var rawDate = entry.article_date || null;
        var sourceDate = normalizeArticleDateString(rawDate) || null; // sempre formato YYYY-MM-DD oppure null
        if (!sourceDate) continue; // se la data non è valida, salta questo articolo per la versione pesata
        var sourceMs = parseDateMs(sourceDate);
        if (isNaN(sourceMs)) sourceMs = Number.MAX_SAFE_INTEGER;
        var objs = extractNationObjectsFromEntry(entry);
        for (var j = 0; j < objs.length; j++) {
            var o = objs[j];
            if (!o || !o.nazione || !o.params) continue;
            if (typeof o.params.importanza_di_questo_articolo !== 'number') continue;
            var importance = o.params.importanza_di_questo_articolo;
            if (importance <= 30) continue;
            var nazione = o.nazione;
            if (!byNation[nazione]) byNation[nazione] = {};
            var factor = 1 + ((importance - 50) / 100);
            for (var key in o.params) {
                if (!o.params.hasOwnProperty(key) || typeof o.params[key] !== 'number') continue;
                if (key === 'importanza_di_questo_articolo' || key === 'GG' || key === 'GR') continue;
                if (!byNation[nazione][key]) byNation[nazione][key] = [];
                var baseVal = o.params[key];
                var weightedVal = baseVal * factor;
                byNation[nazione][key].push({ v: round2(weightedVal), ms: sourceMs, seq: seq++ });
            }
        }
    }
    var out = {};
    for (var n in byNation) {
        if (!byNation.hasOwnProperty(n)) continue;
        out[n] = {};
        for (var p in byNation[n]) {
            if (!byNation[n].hasOwnProperty(p) || !Array.isArray(byNation[n][p])) continue;
            byNation[n][p].sort(function (a, b) {
                if (a.ms !== b.ms) return a.ms - b.ms;
                return a.seq - b.seq;
            });
            out[n][p] = byNation[n][p].map(function (it) { return it.v; });
        }
    }
    // Normalizzazione finale globale: N = valore massimo tra tutti i parametri di tutte le nazioni.
    var N = 0;
    for (var nn in out) {
        if (!out.hasOwnProperty(nn)) continue;
        for (var pp in out[nn]) {
            if (!out[nn].hasOwnProperty(pp) || !Array.isArray(out[nn][pp])) continue;
            for (var ii = 0; ii < out[nn][pp].length; ii++) {
                var vv = out[nn][pp][ii];
                if (typeof vv === 'number' && !isNaN(vv) && vv > N) N = vv;
            }
        }
    }
    if (N > 0) {
        for (var n2 in out) {
            if (!out.hasOwnProperty(n2)) continue;
            for (var p2 in out[n2]) {
                if (!out[n2].hasOwnProperty(p2) || !Array.isArray(out[n2][p2])) continue;
                out[n2][p2] = out[n2][p2].map(function (v) {
                    if (typeof v !== 'number' || isNaN(v)) return v;
                    return round2((v / N) * 100);
                });
            }
        }
    }
    lastEmwaArticlesStats = {
        totalRaw: totalRaw,
        consideredByDate: consideredByDate,
        usedForEmwa: usedForEmwa,
        lookbackHours: lookbackHours,
        generatedAt: new Date().toISOString()
    };
    console.log('[VISION] EMWA_Pesato: articoli totali=' + totalRaw + ', entro lookback=' + consideredByDate + ', usati per EMWA=' + usedForEmwa + ' (lookback ' + lookbackHours + 'h).');
    return out;
}

function writeNazioniElaborateJson(data) {
    var payload = data && typeof data === 'object' ? data : {};
    var ok = writeJson(NAZIONI_ELABORATE_FILE, payload);
    if (ok) console.log('[VISION] Scritto nazionielaborate.json');
    return ok;
}

// Versione pesata: per ogni valore conserva anche peso (importanza articolo) e data origine.
// Solo articoli con data entro emwa_lookback_hours (folder-settings) sono considerati; i più vecchi vengono esclusi.
function buildNazioniElaboratePesatoFromArticoli() {
    var arr = readJson(ARTICOLI_ELABORATI_FILE);
    if (!Array.isArray(arr)) arr = [];
    var rawSettings = readJsonObject(FOLDER_SETTINGS_FILE, null);
    var settings = normalizeFolderSettings(rawSettings);
    var lookbackHours = (settings && typeof settings.emwa_lookback_hours === 'number') ? settings.emwa_lookback_hours : 168;
    var cutoffMs = Date.now() - (lookbackHours * 60 * 60 * 1000);
    var totalRaw = Array.isArray(arr) ? arr.length : 0;
    // Prima seleziona tutti gli articoli entro il lookback, poi ordina per data decrescente
    // e tieni solo i MAX_ARTICOLI_ELABORAZIONE più recenti.
    var candidates = [];
    for (var i = 0; i < arr.length; i++) {
        var entry0 = arr[i] || {};
        var sourceDate0 = entry0.article_date || entry0.timestamp || null;
        var sourceMs0 = parseDateMs(sourceDate0);
        if (isNaN(sourceMs0)) sourceMs0 = Number.MAX_SAFE_INTEGER;
        if (sourceMs0 < cutoffMs) continue; // fuori dal tempo di retroelaborazione
        candidates.push({
            entry: entry0,
            sourceDate: sourceDate0,
            sourceMs: sourceMs0
        });
    }
    // Articoli entro lookback (prima di applicare il limite numerico)
    var consideredByDate = candidates.length;
    // Ordina per data decrescente (più recenti per primi)
    candidates.sort(function (a, b) { return b.sourceMs - a.sourceMs; });
    // Tieni solo i MAX_ARTICOLI_ELABORAZIONE più recenti
    if (candidates.length > MAX_ARTICOLI_ELABORAZIONE) {
        candidates = candidates.slice(0, MAX_ARTICOLI_ELABORAZIONE);
    }
    var usedForEmwa = 0;
    var byNation = {};
    var seq = 0;
    for (var ci = 0; ci < candidates.length; ci++) {
        var entry = candidates[ci].entry || {};
        var sourceDate = candidates[ci].sourceDate || null;
        var sourceMs = candidates[ci].sourceMs;
        var objs = extractNationObjectsFromEntry(entry);
        var usedThisArticle = false;
        for (var j = 0; j < objs.length; j++) {
            var o = objs[j];
            if (!o || !o.nazione || !o.params) continue;
            
            // Fix: usa importance se presente, altrimenti fallback a 50 (neutro) se undefined
            var importance = (typeof o.params.importanza_di_questo_articolo === 'number') 
                ? o.params.importanza_di_questo_articolo 
                : 50;
            
            // Scarta solo se esplicitamente molto bassa (<= 30)
            if (importance <= 30) continue;
            
            var nazione = o.nazione;
            if (!byNation[nazione]) byNation[nazione] = {};
            
            // Fattore di peso: 1.0 per importanza 50. >1 per alta importanza, <1 per bassa.
            var factor = 1 + ((importance - 50) / 100);
            
            for (var key in o.params) {
                // Salta chiavi non numeriche o metadati
                if (!o.params.hasOwnProperty(key) || typeof o.params[key] !== 'number') continue;
                if (key === 'importanza_di_questo_articolo' || key === 'GG' || key === 'GR') continue;
                
                if (!byNation[nazione][key]) byNation[nazione][key] = [];
                
                var baseVal = o.params[key];
                var weightedVal = baseVal * factor;
                
                byNation[nazione][key].push({
                    valore: round2(weightedVal),
                    peso: importance,
                    data: sourceDate || null,
                    ms: sourceMs,
                    seq: seq++
                });
                usedThisArticle = true;
            }
        }
        if (usedThisArticle) usedForEmwa++;
    }
    // Trova il massimo globale tra tutti i valori, come per nazionielaborate.json
    var N = 0;
    for (var nn in byNation) {
        if (!byNation.hasOwnProperty(nn)) continue;
        for (var pp in byNation[nn]) {
            if (!byNation[nn].hasOwnProperty(pp) || !Array.isArray(byNation[nn][pp])) continue;
            for (var ii = 0; ii < byNation[nn][pp].length; ii++) {
                var vv = byNation[nn][pp][ii].valore;
                if (typeof vv === 'number' && !isNaN(vv) && vv > N) N = vv;
            }
        }
    }
    var out = {};
    // Ordina le nazioni per numero totale di parametri (somma delle lunghezze dei vettori) in ordine decrescente
    var nationKeys = Object.keys(byNation || {});
    nationKeys.sort(function (a, b) {
        var ca = 0, cb = 0;
        var pa = byNation[a] || {};
        var pb = byNation[b] || {};
        for (var k in pa) {
            if (!pa.hasOwnProperty(k) || !Array.isArray(pa[k])) continue;
            ca += pa[k].length;
        }
        for (var k2 in pb) {
            if (!pb.hasOwnProperty(k2) || !Array.isArray(pb[k2])) continue;
            cb += pb[k2].length;
        }
        return cb - ca;
    });
    nationKeys.forEach(function (n) {
        if (!byNation.hasOwnProperty(n)) return;
        // Calcola il numero totale di parametri (tutti i punti) per questa nazione
        var totalParams = 0;
        var perNation = byNation[n] || {};
        for (var pk in perNation) {
            if (!perNation.hasOwnProperty(pk) || !Array.isArray(perNation[pk])) continue;
            totalParams += perNation[pk].length;
        }
        // Salta le nazioni con meno di 5 parametri totali
        if (totalParams < 5) return;

        out[n] = {};
        for (var p in byNation[n]) {
            if (!byNation[n].hasOwnProperty(p) || !Array.isArray(byNation[n][p])) continue;
            var items = byNation[n][p].slice();
            items.sort(function (a, b) {
                if (a.ms !== b.ms) return a.ms - b.ms;
                if (a.peso !== b.peso) return a.peso - b.peso;
                return a.seq - b.seq;
            });
            out[n][p] = items.map(function (it) {
                var v = it.valore;
                var vNorm = (typeof v === 'number' && !isNaN(v) && N > 0) ? round2((v / N) * 100) : v;
                return {
                    valore: vNorm,
                    peso: it.peso,
                    data: it.data
                };
            });
        }
    });
    lastEmwaArticlesStats = {
        totalRaw: totalRaw,
        consideredByDate: consideredByDate,
        usedForEmwa: usedForEmwa,
        lookbackHours: lookbackHours,
        generatedAt: new Date().toISOString()
    };
    console.log('[VISION] EMWA_Pesato: articoli totali=' + totalRaw + ', entro lookback=' + consideredByDate + ', usati per EMWA=' + usedForEmwa + ' (lookback ' + lookbackHours + 'h).');
    return out;
}

function writeNazioniElaboratePesatoJson(data) {
    var payload = data && typeof data === 'object' ? data : {};
    var ok = writeJson(NAZIONI_ELABORATE_PESATO_FILE, payload);
    if (ok) console.log('[VISION] Scritto EMWA_Pesato.json');
    return ok;
}

// Costruisce la versione "sommata" da EMWA_Pesato.json
// Struttura: { Nazione: { parametro: valore_corrente, ... }, ... }
function buildNazioniElaboratePesatoSommato() {
    var data = readJsonObject(NAZIONI_ELABORATE_PESATO_FILE, {});
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    var out = {};

    // Parametri per l'algoritmo (coerenti con lo snippet Python fornito)
    var lambdaVal = 0.01;
    var alpha = 0.3;

    function computeCurrentValue(list) {
        if (!Array.isArray(list) || list.length === 0) return null;
        // Filtra solo elementi con valore, peso e data validi
        var items = list.filter(function (r) {
            return r &&
                typeof r.valore === 'number' && !isNaN(r.valore) &&
                typeof r.peso === 'number' && !isNaN(r.peso) &&
                r.data;
        });
        if (items.length === 0) return null;
        // Converte le date in oggetti Date (formato atteso: YYYY-MM-DD)
        items.forEach(function (r) {
            try {
                r._dateObj = new Date(r.data + 'T00:00:00Z');
            } catch (e) {
                r._dateObj = null;
            }
        });
        var validItems = items.filter(function (r) {
            return r._dateObj instanceof Date && !isNaN(r._dateObj.getTime());
        });
        if (validItems.length === 0) return null;
        // Trova la data più recente
        var dataMax = validItems.reduce(function (max, r) {
            return (!max || r._dateObj > max) ? r._dateObj : max;
        }, null);
        // Calcola i pesi combinati
        var pesiCombinati = validItems.map(function (r) {
            var giorni = Math.max(0, Math.floor((dataMax - r._dateObj) / (1000 * 60 * 60 * 24)));
            var fattore = Math.exp(-lambdaVal * giorni);
            return r.peso * fattore;
        });
        // EWMA pesato
        var S = validItems[0].valore;
        for (var i = 1; i < validItems.length; i++) {
            var w = pesiCombinati[i];
            var num = alpha * w * validItems[i].valore + (1 - alpha) * S;
            var den = alpha * w + (1 - alpha);
            if (den === 0) continue;
            S = num / den;
        }
        return round2(S);
    }

    for (var nazione in data) {
        if (!data.hasOwnProperty(nazione)) continue;
        var perNation = data[nazione];
        if (!perNation || typeof perNation !== 'object' || Array.isArray(perNation)) continue;
        var nationOut = {};
        for (var key in perNation) {
            if (!perNation.hasOwnProperty(key) || !Array.isArray(perNation[key])) continue;
            var val = computeCurrentValue(perNation[key]);
            if (val != null && !isNaN(val)) {
                nationOut[key] = val;
            }
        }
        if (Object.keys(nationOut).length > 0) {
            out[nazione] = nationOut;
        }
    }
    return out;
}

function writeNazioniElaboratePesatoSommatoJson(data) {
    var payload = data && typeof data === 'object' ? data : {};
    // Ordina le nazioni per numero di parametri disponibili (chiavi nel sotto-oggetto) in ordine decrescente
    try {
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            var entries = Object.keys(payload).map(function (name) {
                var params = payload[name] || {};
                var paramCount = 0;
                if (params && typeof params === 'object' && !Array.isArray(params)) {
                    paramCount = Object.keys(params).length;
                }
                return { name: name, params: params, count: paramCount };
            });
            entries.sort(function (a, b) { return b.count - a.count; });
            var sorted = {};
            entries.forEach(function (e) {
                sorted[e.name] = e.params;
            });
            payload = sorted;
        }
    } catch (e) {
        console.warn('[VISION] writeNazioniElaboratePesatoSommatoJson: ordinamento per numero di parametri non riuscito:', e.message);
    }
    var ok = writeJson(NAZIONI_ELABORATE_PESATO_SOMMATO_FILE, payload);
    if (ok) console.log('[VISION] Scritto EMWA_Pesato_Sommato.json');
    return ok;
}

// Aggiornamento automatico di EMWA_Pesato.json, EMWA_Pesato_Sommato.json e Articoli_riassunto.json
async function maybeAutoUpdateEmwaAndArticoli() {
    try {
        var rawSettings = readJsonObject(FOLDER_SETTINGS_FILE, null);
        var settings = normalizeFolderSettings(rawSettings);
        var every = parseInt(settings && settings.json_update_every, 10);
        if ([0, 10, 20, 50, 100].indexOf(every) === -1) every = 0;
        if (!every) {
            jsonAutoUpdatePending = 0;
            return;
        }
        jsonAutoUpdatePending++;
        if (jsonAutoUpdatePending < every) return;
        if (jsonAutoUpdateInProgress) return;
        jsonAutoUpdatePending = 0;
        jsonAutoUpdateInProgress = true;
        try {
            var data = buildNazioniElaboratePesatoFromArticoli();
            writeNazioniElaboratePesatoJson(data);
            var sommato = buildNazioniElaboratePesatoSommato();
            writeNazioniElaboratePesatoSommatoJson(sommato);
            buildAndWriteArticoliRiassunto();
        } finally {
            jsonAutoUpdateInProgress = false;
        }
    } catch (e) {
        jsonAutoUpdateInProgress = false;
        console.error('[VISION] Auto-update EMWA/Articoli_riassunto error:', e.message);
    }
}

// API: genera solo EMWA_Pesato.json (e relativo sommato) a partire da articolielaborati.json
app.post('/api/elabora-nazioni-pesate', (req, res) => {
    try {
        var data = buildNazioniElaboratePesatoFromArticoli();
        var ok = writeNazioniElaboratePesatoJson(data);
        if (!ok) return res.status(500).json({ success: false, error: 'Impossibile scrivere EMWA_Pesato.json' });

        var sommato = buildNazioniElaboratePesatoSommato();
        writeNazioniElaboratePesatoSommatoJson(sommato);

        // Dopo aver generato EMWA_Pesato.json e EMWA_Pesato_Sommato.json, genera Articoli_riassunto.json
        buildAndWriteArticoliRiassunto();

        var total = 0;
        if (data && typeof data === 'object') {
            Object.keys(data).forEach(function (n) {
                var perNation = data[n] || {};
                for (var p in perNation) {
                    if (!perNation.hasOwnProperty(p) || !Array.isArray(perNation[p])) continue;
                    total += perNation[p].length;
                }
            });
        }
        res.json({ success: true, count: total });
    } catch (e) {
        console.error('elabora-nazioni-pesate error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

function updateEWMA(prevValue, newValue, lambda) {
    if (prevValue === null || prevValue === undefined) return newValue;
    return lambda * prevValue + (1 - lambda) * newValue;
}

function buildNazioniEWMAFromNazioniElaborate(lambda) {
    var l = (typeof lambda === 'number' && lambda > 0 && lambda < 1) ? lambda : 0.85;
    var data = readJsonObject(NAZIONI_ELABORATE_FILE, {});
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    var out = {};
    for (var nazione in data) {
        if (!data.hasOwnProperty(nazione)) continue;
        var params = data[nazione];
        if (!params || typeof params !== 'object' || Array.isArray(params)) continue;
        out[nazione] = {};
        for (var key in params) {
            if (!params.hasOwnProperty(key) || !Array.isArray(params[key])) continue;
            var arr = params[key];
            var ewma = null;
            for (var i = 0; i < arr.length; i++) {
                var v = arr[i];
                if (typeof v !== 'number' || isNaN(v)) continue;
                ewma = updateEWMA(ewma, v, l);
            }
            if (ewma !== null) out[nazione][key] = round2(ewma);
        }
        if (Object.keys(out[nazione]).length === 0) delete out[nazione];
    }
    return out;
}

function writeNazioniEwmaJson(data) {
    // V0 nazioniEWMA.json disabilitato: non scriviamo più il file.
    return true;
}

// Sintesi finale per EMWA_Pesato_Sommato -> sintesi_EMWA_Pesato_Sommato.json (+ opz. sintesi IA + opz. Articoli_riassunto)
// options.skipArticoliRiassunto = true: non generare Articoli_riassunto.json (usato dal tasto "Elabora sintesi")
async function updateSintesiNazioniElabPesatoSommato(options) {
    try {
        var data = readJsonObject(NAZIONI_ELABORATE_PESATO_SOMMATO_FILE, {});
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
            await writeJsonSerialized(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE, []);
            console.log('[VISION] nessuna nazione in EMWA_Pesato_Sommato.json: final_summary pesato non eseguito.');
            // Anche se non ci sono nazioni EMWA, genera comunque Articoli_riassunto.json
            // così V_RED e la chat possono usare almeno il dataset degli articoli.
            try {
                if (!(options && options.skipArticoliRiassunto)) buildAndWriteArticoliRiassunto();
            } catch (e2) {
                console.error('updateSintesiNazioniElabPesatoSommato -> buildAndWriteArticoliRiassunto error:', e2.message);
            }
            return null;
        }
        var prompt = (config.prompts && config.prompts.question_EMWA_Pesato_Sommato) || '';
        var useEmwaCombo = getUseEmwaParamsFromFolderSettings();
        var payloadObj;
        if (useEmwaCombo) {
            var articoli = readJson(ARTICOLI_RIASSUNTO_FILE);
            if (!Array.isArray(articoli)) articoli = [];
            // Ordine voluto: prima Articoli_riassunto, poi EMWA_Pesato_Sommato
            payloadObj = {
                Articoli_riassunto: articoli,
                EMWA_Pesato_Sommato: data
            };
        } else {
            payloadObj = data;
        }
        var payload = JSON.stringify(payloadObj, null, 2);
        console.log('');
        console.log('========== FASE final_summary (EMWA_Pesato_Sommato) ==========');
        console.log('[VISION] final_summary_pesato -> System prompt:');
        console.log('--- inizio system ---');
        console.log(prompt);
        console.log('--- fine system ---');
        console.log('[VISION] final_summary_pesato -> User content:');
        console.log('--- inizio user ---');
        console.log(payload);
        console.log('--- fine user ---');
        var modelEmwa = (config.ai_deepseek_models_by_stage && config.ai_deepseek_models_by_stage.final_summary_pesato)
            || config.ai_deepseek_model_reasoner
            || config.ai_deepseek_model;
        var aiResponse = await callAI(prompt, payload, { stage: 'final_summary_pesato' });
        recordQuestion('final_summary_pesato', payload, aiResponse, { source: 'updateSintesiNazioniElabPesatoSommato', system: prompt });
        var parsed = parseSintesiResponseFromIA(aiResponse);
        var numParsed = (parsed.rawArray || []).length;
        if (numParsed > 0) {
            await writeJsonSerialized(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE, parsed.rawArray);
            console.log('[VISION] Sintesi EMWA_Pesato_Sommato: ' + numParsed + ' nazioni -> sintesi_EMWA_Pesato_Sommato.json');
        } else {
            console.error('[VISION] final_summary_pesato: parsing fallito (0 nazioni). Mantengo ultimo file valido.');
            return 'Error: final_summary_pesato parsing fallito (mantengo ultimo file valido)';
        }
        // Genera Articoli_riassunto.json prima della sintesi IA (question_EMWA_Pesato_Sommato_IA lo riceve in allegato)
        if (!(options && options.skipArticoliRiassunto)) buildAndWriteArticoliRiassunto();
        // Sintesi IA testuale (con EMWA_Pesato_Sommato + Articoli_riassunto in user content)
        await updateSintesiNazioniElabPesatoSommatoIA();
        return aiResponse;
    } catch (e) {
        console.error('updateSintesiNazioniElabPesatoSommato error:', e.message);
        return null;
    }
}

// Sintesi IA testuale da dataset selezionato:
// - se use_emwa_params è SPENTO: usa solo Articoli_riassunto.json
// - se use_emwa_params è ACCESO: usa Articoli_riassunto.json + EMWA_Pesato_Sommato.json insieme
async function updateSintesiNazioniElabPesatoSommatoIA() {
    try {
        var prompt = (config.prompts && config.prompts.question_EMWA_Pesato_Sommato_IA) || '';
        if (!prompt) {
            console.warn('[VISION] question_EMWA_Pesato_Sommato_IA non definito in config.prompts.');
            return null;
        }
        var sourceDataset = getSharedQuestionDataset();
        var payload = JSON.stringify(sourceDataset.data, null, 2);
        console.log('');
        console.log('========== FASE question_EMWA_Pesato_Sommato_IA (sintesi testuale da ' + sourceDataset.file + ') ==========');
        console.log('[VISION] question_EMWA_Pesato_Sommato_IA -> System prompt:');
        console.log('--- inizio system ---');
        console.log(prompt);
        console.log('--- fine system ---');
        console.log('[VISION] question_EMWA_Pesato_Sommato_IA -> User content (' + sourceDataset.file + '):');
        console.log('--- inizio user ---');
        console.log(payload);
        console.log('--- fine user ---');
        var modelEmwaIa = (config.ai_deepseek_models_by_stage && config.ai_deepseek_models_by_stage.question_EMWA_Pesato_Sommato_IA)
            || config.ai_deepseek_model_reasoner
            || config.ai_deepseek_model;
        var aiResponse = await callAI(prompt, payload, { stage: 'question_EMWA_Pesato_Sommato_IA' });
        var respStr = aiResponse != null ? String(aiResponse) : '';
        recordQuestion('question_EMWA_Pesato_Sommato_IA', payload, respStr, { source: 'updateSintesiNazioniElabPesatoSommatoIA', system: prompt });
        var parsed = parseSintesiResponseFromIA(respStr);
        var rawArray = parsed && Array.isArray(parsed.rawArray) ? parsed.rawArray : [];
        if (!rawArray.length) {
            console.error('[VISION] question_EMWA_Pesato_Sommato_IA: parsing fallito (0 nazioni). Mantengo ultimo file valido.');
            return 'Error: question_EMWA_Pesato_Sommato_IA parsing fallito (mantengo ultimo file valido)';
        }
        await writeJsonSerialized(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_IA_FILE, rawArray);
        console.log('[VISION] question_EMWA_Pesato_Sommato_IA completata -> sintesi_EMWA_Pesato_Sommato_IA.json (' + rawArray.length + ' nazioni)');
        return respStr;
    } catch (e) {
        console.error('updateSintesiNazioniElabPesatoSommatoIA error:', e.message);
        return null;
    }
}

// API: elabora solo le 2 sintesi (sintesi_EMWA_Pesato_Sommato + sintesi_EMWA_Pesato_Sommato_IA), senza Articoli_riassunto
app.post('/api/elabora-sintesi-pesata', async (req, res) => {
    try {
        var aiResponse = await updateSintesiNazioniElabPesatoSommato({ skipArticoliRiassunto: true });
        if (typeof aiResponse === 'string' && aiResponse.indexOf('Error:') === 0) {
            return res.json({ success: false, error: aiResponse, ai_response: aiResponse, count: 0 });
        }
        var data = readJsonObject(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE, null);
        var count = 0;
        if (Array.isArray(data)) {
            count = data.length;
        } else if (data && typeof data === 'object') {
            var parsed = parseSintesiResponseFromIA(data);
            count = (parsed.rawArray || []).length;
        }
        res.json({
            success: true,
            count: count,
            ai_response: aiResponse != null ? String(aiResponse) : null
        });
    } catch (e) {
        console.error('elabora-sintesi-pesata error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// API: genera solo Articoli_riassunto.json da articolielaborati.json
app.post('/api/elabora-riassunto', (req, res) => {
    try {
        buildAndWriteArticoliRiassunto();
        var stats = lastRiassuntoArticlesStats || null;
        res.json({ success: true, stats: stats });
    } catch (e) {
        console.error('elabora-riassunto error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// API: legge sintesi_EMWA_Pesato_Sommato_IA.json come mappa per popup (byNation/byCode)
app.get('/api/sintesi-emwa-pesato-ia', (req, res) => {
    try {
        var data = readJsonObject(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_IA_FILE, null) || {};
        var rawArray = Array.isArray(data) ? data : (Array.isArray(data.rawArray) ? data.rawArray : []);
        var parsed = parseSintesiResponseFromIA(rawArray.length ? rawArray : (data.response || ''));
        res.json({ byNation: parsed.byNation || {}, byCode: parsed.byCode || {} });
    } catch (e) {
        console.error('/api/sintesi-emwa-pesato-ia error:', e.message);
        res.json({ byNation: {}, byCode: {} });
    }
});

// API: nazioni aggregate (media parametri) — FASE 4.5 disabilitata: restituisce struttura vuota
app.get('/api/nazioni-aggregate', (req, res) => {
    res.json({ byNation: {}, byCode: {} });
});

// Sintesi per nazione (una riga per nazione generata dall'IA con final_summary). Aggiornata dopo ogni articolo.
var nazioniSintesi = { byCode: {}, byNation: {} };

function writeSintesiNazioniJson() {
    var ok = writeJson(SINTESI_NAZIONI_FILE, nazioniSintesiRawArray);
    if (ok) {
        console.log('Scritto sintesinazioni.json -> ' + SINTESI_NAZIONI_FILE);
    } else {
        console.error('Scrittura sintesinazioni.json FALLITA');
    }
}

// Estrae il primo oggetto JSON da una stringa (per risposte IA con testo intorno)
function extractFirstJsonObject(str) {
    if (!str || typeof str !== 'string') return null;
    var s = str.trim();
    var start = s.indexOf('{');
    if (start === -1) return null;
    var depth = 0, inStr = false, strCh = '';
    for (var i = start; i < s.length; i++) {
        var c = s[i];
        if (!inStr) {
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.substring(start, i + 1)); } catch (_) {} return null; } }
            else if ((c === '"' || c === "'") && (i === 0 || s[i - 1] !== '\\')) { inStr = true; strCh = c; }
        } else if (c === strCh && (i === 0 || s[i - 1] !== '\\')) inStr = false;
    }
    return null;
}

// Estrae il primo array JSON da una stringa (risposta sintesi tipo [{"nazione":"...","GG":n,"GR":n},...])
function extractFirstJsonArray(str) {
    if (!str || typeof str !== 'string') return null;
    var s = str.trim();
    var start = s.indexOf('[');
    if (start === -1) return null;
    var depth = 0, inStr = false, strCh = '';
    for (var i = start; i < s.length; i++) {
        var c = s[i];
        if (!inStr) {
            if (c === '[') depth++;
            else if (c === ']') { depth--; if (depth === 0) { try { return JSON.parse(s.substring(start, i + 1)); } catch (_) {} return null; } }
            else if ((c === '"' || c === "'") && (i === 0 || s[i - 1] !== '\\')) { inStr = true; strCh = c; }
        } else if (c === strCh && (i === 0 || s[i - 1] !== '\\')) inStr = false;
    }
    return null;
}

// Parsing risposta sintesi: supporta "obj, obj, obj" senza parentesi quadre (da primo { a ultimo })
function parseCommaSeparatedSintesiObjects(str) {
    if (!str || typeof str !== 'string') return null;
    var s = str.trim();
    var first = s.indexOf('{');
    var last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    try {
        return JSON.parse('[' + s.substring(first, last + 1) + ']');
    } catch (_) {
        return null;
    }
}

// Da un item della risposta estrae solo nazione, GG, GR (stesso formato ricevuto, nessuna chiave extra)
function sintesiItemOnlyNazioneGGGR(item) {
    if (!item || !item.nazione) return null;
    var nazione = String(item.nazione).trim();
    var GG = item.GG != null ? item.GG : item.gg;
    var GR = item.GR != null ? item.GR : item.gr;
    return { nazione: nazione, GG: GG, GR: GR };
}

// Elabora solo la risposta IA della SINTESI. Ritorna { rawArray, byNation, byCode }.
// rawArray = array da scrivere nel file (solo nazione, GG, GR; nessuna nazione aggiunta).
function parseSintesiResponseFromIA(aiResponse) {
    var rawArray = [];
    var byNation = {};
    var byCode = {};
    var data = null;
    if (typeof aiResponse === 'string') {
        var s = aiResponse.trim();
        var jsonMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) s = jsonMatch[1].trim();
        try {
            data = JSON.parse(s);
        } catch (_) {
            if (s.indexOf('[') !== -1 && (s.indexOf('[') < s.indexOf('{') || s.indexOf('{') === -1)) {
                data = extractFirstJsonArray(aiResponse);
            }
            if (!data) data = extractFirstJsonObject(aiResponse);
            if (!data) data = parseCommaSeparatedSintesiObjects(aiResponse);
        }
    } else if (aiResponse && typeof aiResponse === 'object') {
        data = aiResponse;
    }
    if (!data) return { rawArray: [], byNation: {}, byCode: {} };

    function toArray(arr) {
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var item = sintesiItemOnlyNazioneGGGR(arr[i]);
            if (item) {
                out.push(item);
                var nn = nations.getCanonicalNameIfValid ? nations.getCanonicalNameIfValid(item.nazione) : item.nazione;
                if (nn) {
                    byNation[nn] = { sintesi: '', gg: item.GG, gr: item.GR };
                    var code = nations.getNationIsoCode ? nations.getNationIsoCode(nn) : null;
                    if (code) byCode[code.toLowerCase()] = { nazione: nn, sintesi: '', gg: item.GG, gr: item.GR };
                }
            }
        }
        return out;
    }

    if (Array.isArray(data)) {
        rawArray = toArray(data);
        return { rawArray: rawArray, byNation: byNation, byCode: byCode };
    }
    if (Array.isArray(data.nazioni)) {
        rawArray = toArray(data.nazioni);
        return { rawArray: rawArray, byNation: byNation, byCode: byCode };
    }
    if (data.byNation && typeof data.byNation === 'object') {
        for (var n in data.byNation) {
            if (!data.byNation.hasOwnProperty(n)) continue;
            var v = data.byNation[n];
            var gg = (v && (v.GG != null ? v.GG : v.gg != null ? v.gg : null));
            var gr = (v && (v.GR != null ? v.GR : v.gr != null ? v.gr : null));
            rawArray.push({ nazione: n.trim(), GG: gg, GR: gr });
            var nn = nations.getCanonicalNameIfValid ? nations.getCanonicalNameIfValid(n) : n.trim();
            if (nn) {
                byNation[nn] = { sintesi: '', gg: gg, gr: gr };
                var code = nations.getNationIsoCode ? nations.getNationIsoCode(nn) : null;
                if (code) byCode[code.toLowerCase()] = { nazione: nn, sintesi: '', gg: gg, gr: gr };
            }
        }
        return { rawArray: rawArray, byNation: byNation, byCode: byCode };
    }
    return { rawArray: [], byNation: {}, byCode: {} };
}

// Alias: ritorna solo byNation/byCode per compatibilità
function parseSintesiFromJson(aiResponse) {
    var r = parseSintesiResponseFromIA(aiResponse);
    return { byNation: r.byNation, byCode: r.byCode };
}

// sintesinazioni.json (V1 – sintesi da EWMA) DEPRECATO.
// La sintesi "ufficiale" per GG/GR ora deriva da sintesi_EMWA_Pesato_Sommato.json.
var nazioniSintesiRawArray = [];

async function runFinalSummaryFromEwma(byNation, sourceTag) {
    // V1 (sintesinazioni.json) disabilitato: questa funzione è mantenuta solo per compatibilità.
    console.log('[VISION] final_summary da EWMA (V1) disabilitato: nessuna chiamata IA né scrittura di sintesinazioni.json.');
        nazioniSintesi = { byCode: {}, byNation: {} };
    nazioniSintesiRawArray = [];
        return null;
}

async function updateNazioniSintesi() {
    try {
        // nazionielaborate.json non più generato (pipeline usa solo EMWA_Pesato / EMWA_Pesato_Sommato)
        var nazioniElaboratePesato = buildNazioniElaboratePesatoFromArticoli();
        writeNazioniElaboratePesatoJson(nazioniElaboratePesato);
        var nazioniElaboratePesatoSommato = buildNazioniElaboratePesatoSommato();
        writeNazioniElaboratePesatoSommatoJson(nazioniElaboratePesatoSommato);
        // Sintesi principale ora basata su EMWA_Pesato_Sommato (non più su sintesinazioni.json / V1)
        var aiResponsePesato = await updateSintesiNazioniElabPesatoSommato();
        return aiResponsePesato;
    } catch (e) {
        console.error('updateNazioniSintesi error:', e.message);
        return null;
    }
}

// Sintesi alternativa (stima IA): stessa struttura di sintesi, salvata in sintesialternativa.json, richiesta allo STOP
var nazioniSintesiAlternativaRawArray = [];
var nazioniEmwaIaRawArray = [];
var sintesiEmwaRawArray = [];
var sintesiV4RawArray = [];

function readSintesiAlternativaFromFile() {
    var data = readJsonObject(SINTESI_ALTERNATIVA_FILE, null);
    if (Array.isArray(data)) {
        nazioniSintesiAlternativaRawArray = data;
        var r = parseSintesiResponseFromIA(data);
        return { byNation: r.byNation, byCode: r.byCode };
    }
    if (data && typeof data === 'object' && (data.byNation || data.byCode)) {
        nazioniSintesiAlternativaRawArray = [];
        for (var n in (data.byNation || {})) {
            if (!(data.byNation).hasOwnProperty(n)) continue;
            var v = data.byNation[n];
            nazioniSintesiAlternativaRawArray.push({ nazione: n, GG: v.gg != null ? v.gg : v.GG, GR: v.gr != null ? v.gr : v.GR });
        }
        return { byNation: data.byNation || {}, byCode: data.byCode || {} };
    }
    nazioniSintesiAlternativaRawArray = [];
    return { byNation: {}, byCode: {} };
}

function writeSintesiAlternativaJson() {
    var ok = writeJson(SINTESI_ALTERNATIVA_FILE, nazioniSintesiAlternativaRawArray);
    if (ok) console.log('[VISION] Scritto sintesialternativa.json');
    return ok;
}

function readNazioniEmwaIaFromFile() {
    var data = readJsonObject(NAZIONI_EMWA_IA_FILE, null);
    if (Array.isArray(data)) {
        nazioniEmwaIaRawArray = data;
        var byNation = {};
        var byCode = {};
        for (var i = 0; i < data.length; i++) {
            var o = data[i];
            if (!o || !o.nazione) continue;
            var nn = nations.getCanonicalNameIfValid ? nations.getCanonicalNameIfValid(String(o.nazione).trim()) : String(o.nazione).trim();
            if (!nn) continue;
            var info = { nazione: nn };
            var gg = (o.GG != null ? o.GG : (o.gg != null ? o.gg : null));
            var gr = (o.GR != null ? o.GR : (o.gr != null ? o.gr : null));
            if (typeof gg === 'number') info.gg = gg;
            if (typeof gr === 'number') info.gr = gr;
            var params = {};
            for (var k in o) {
                if (!o.hasOwnProperty(k)) continue;
                if (k === 'nazione' || k === 'commento' || k === 'GG' || k === 'GR' || k === 'gg' || k === 'gr') continue;
                if (typeof o[k] === 'number') params[k] = o[k];
            }
            if (Object.keys(params).length > 0) info.params = params;
            byNation[nn] = info;
            var code = nations.getNationIsoCode ? nations.getNationIsoCode(nn) : null;
            if (code) byCode[code.toLowerCase()] = info;
        }
        return { byNation: byNation, byCode: byCode };
    }
    if (data && typeof data === 'object' && (data.byNation || data.byCode)) {
        return { byNation: data.byNation || {}, byCode: data.byCode || {} };
    }
    nazioniEmwaIaRawArray = [];
    return { byNation: {}, byCode: {} };
}

function writeNazioniEmwaIaJson() {
    var ok = writeJson(NAZIONI_EMWA_IA_FILE, nazioniEmwaIaRawArray);
    if (ok) console.log('[VISION] Scritto nazioniEMWA_IA.json');
    return ok;
}

function writeSintesiEmwaJson() {
    var ok = writeJson(SINTESI_EMWA_FILE, sintesiEmwaRawArray);
    if (ok) console.log('[VISION] Scritto sintesiEMWA.json');
    return ok;
}

function readSintesiEmwaFromFile() {
    var data = readJsonObject(SINTESI_EMWA_FILE, null);
    if (Array.isArray(data)) {
        sintesiEmwaRawArray = data;
        var r = parseSintesiResponseFromIA(data);
        return { byNation: r.byNation, byCode: r.byCode };
    }
    if (data && typeof data === 'object' && (data.byNation || data.byCode)) {
        sintesiEmwaRawArray = [];
        for (var n in (data.byNation || {})) {
            if (!(data.byNation).hasOwnProperty(n)) continue;
            var v = data.byNation[n];
            sintesiEmwaRawArray.push({ nazione: n, GG: v.gg != null ? v.gg : v.GG, GR: v.gr != null ? v.gr : v.GR });
        }
        return { byNation: data.byNation || {}, byCode: data.byCode || {} };
    }
    sintesiEmwaRawArray = [];
    return { byNation: {}, byCode: {} };
}

function writeSintesiV4Json() {
    // V4 deprecata: non scrivere più il file né loggare
    return true;
}

function readSintesiV4FromFile() {
    var data = readJsonObject(SINTESI_V4_FILE, null);
    if (Array.isArray(data)) {
        sintesiV4RawArray = data;
        var r = parseSintesiResponseFromIA(data);
        return { byNation: r.byNation, byCode: r.byCode };
    }
    if (data && typeof data === 'object' && (data.byNation || data.byCode)) {
        sintesiV4RawArray = [];
        for (var n in (data.byNation || {})) {
            if (!(data.byNation).hasOwnProperty(n)) continue;
            var v = data.byNation[n];
            sintesiV4RawArray.push({ nazione: n, GG: v.gg != null ? v.gg : v.GG, GR: v.gr != null ? v.gr : v.GR });
        }
        return { byNation: data.byNation || {}, byCode: data.byCode || {} };
    }
    sintesiV4RawArray = [];
    return { byNation: {}, byCode: {} };
}

var sintesiV5RawArray = [];

function writeSintesiV5Json() {
    // V5 deprecata: non scrivere più il file né loggare
    return true;
}

// V6 (sintesiNazioniElaborate_IA.json) disabilitato: manteniamo solo file vuoto per compatibilità
var sintesiNazioniElabIaRawArray = [];

function readSintesiV5FromFile() {
    var data = readJsonObject(SINTESI_V5_FILE, null);
    if (Array.isArray(data)) {
        sintesiV5RawArray = data;
        var r = parseSintesiResponseFromIA(data);
        return { byNation: r.byNation, byCode: r.byCode };
    }
    if (data && typeof data === 'object' && (data.byNation || data.byCode)) {
        sintesiV5RawArray = [];
        for (var n in (data.byNation || {})) {
            if (!(data.byNation).hasOwnProperty(n)) continue;
            var v = data.byNation[n];
            sintesiV5RawArray.push({ nazione: n, GG: v.gg != null ? v.gg : v.GG, GR: v.gr != null ? v.gr : v.GR });
        }
        return { byNation: data.byNation || {}, byCode: data.byCode || {} };
    }
    sintesiV5RawArray = [];
    return { byNation: {}, byCode: {} };
}

function sintesiToArray(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && data.byNation) {
        var arr = [];
        for (var n in data.byNation) {
            if (!data.byNation.hasOwnProperty(n)) continue;
            var v = data.byNation[n];
            arr.push({ nazione: n, GG: v.gg != null ? v.gg : v.GG, GR: v.gr != null ? v.gr : v.GR });
        }
        return arr;
    }
    return [];
}

function writeSintesiVRedJson(payload) {
    var value = payload;
    if (value === undefined || value === null) value = {};
    var ok = writeJson(SINTESI_VRED_FILE, value);
    if (ok) console.log('[VISION] Scritto sintesiVRED.json');
    return ok;
}

function normalizeWeights(arr) {
    var sum = 0;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        var w = (typeof arr[i] === 'number' && isFinite(arr[i]) && arr[i] > 0) ? arr[i] : 0;
        out.push(w);
        sum += w;
    }
    if (sum <= 0) return out.map(function () { return 0; });
    return out.map(function (w) { return w / sum; });
}

function weightedMean(values, weights) {
    var sumW = 0;
    var sumV = 0;
    for (var i = 0; i < values.length; i++) {
        var v = values[i];
        var w = weights[i];
        if (typeof v !== 'number' || !isFinite(v) || typeof w !== 'number' || !isFinite(w) || w <= 0) continue;
        sumW += w;
        sumV += (v * w);
    }
    if (sumW <= 0) return null;
    return sumV / sumW;
}

function getNumberOrNull(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
        var n = Number(v);
        if (isFinite(n)) return n;
    }
    return null;
}

function getDottrinaNucleare(paese) {
    var all = (config && config.dottrine_nucleari && typeof config.dottrine_nucleari === 'object') ? config.dottrine_nucleari : {};
    var d = all[paese];
    if (d && typeof d === 'object') {
        return {
            min_ratio: (typeof d.min_ratio === 'number' && isFinite(d.min_ratio)) ? d.min_ratio : 1.0,
            forza_null: d.forza_null === true
        };
    }
    return { min_ratio: 1.0, forza_null: true };
}

function buildSintesiV4FromSources(v1ByNation, v2ByNation, v3ByNation) {
    var out = [];
    var all = {};
    Object.keys(v1ByNation || {}).forEach(function (n) { all[n] = true; });
    Object.keys(v2ByNation || {}).forEach(function (n) { all[n] = true; });
    Object.keys(v3ByNation || {}).forEach(function (n) { all[n] = true; });
    var names = Object.keys(all).filter(Boolean).sort();
    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var v1 = (v1ByNation && v1ByNation[name]) || {};
        var v2 = (v2ByNation && v2ByNation[name]) || {};
        var v3 = (v3ByNation && v3ByNation[name]) || {};
        var ggInputsRaw = [getNumberOrNull(v1.gg), getNumberOrNull(v2.gg), getNumberOrNull(v3.gg)];
        var grInputsRaw = [getNumberOrNull(v1.gr), getNumberOrNull(v2.gr), getNumberOrNull(v3.gr)];
        var versions = [v1, v2, v3];

        // ---------- GG ----------
        var ggBaseWeights = [0.35, 0.40, 0.25];
        var ggValuesPresent = [];
        var ggWeightsPresent = [];
        var ggThresholds = (config && config.soglie_gg_minime && typeof config.soglie_gg_minime === 'object') ? config.soglie_gg_minime : {};
        var ggMinDefault = 3650;
        var ggMinForCountry = (typeof ggThresholds[name] === 'number' && isFinite(ggThresholds[name])) ? ggThresholds[name] : ggMinDefault;
        for (var vi = 0; vi < versions.length; vi++) {
            var ggv = getNumberOrNull(versions[vi].gg);
            if (ggv != null) {
                ggValuesPresent.push(ggv);
                ggWeightsPresent.push(ggBaseWeights[vi]);
            }
        }
        var ggOut = null;
        if (ggValuesPresent.length === 0) {
            ggOut = ggMinForCountry;
        } else if (ggValuesPresent.length === 1) {
            ggOut = Math.max(Math.round(ggValuesPresent[0]), ggMinForCountry);
        } else {
            var ggMean = ggValuesPresent.reduce(function (a, b) { return a + b; }, 0) / ggValuesPresent.length;
            var ggOutlierThreshold = Math.max(30, ggMean * 0.5);
            var ggAdjusted = [];
            for (var gi = 0; gi < ggValuesPresent.length; gi++) {
                var gw = ggWeightsPresent[gi];
                if (Math.abs(ggValuesPresent[gi] - ggMean) > ggOutlierThreshold) gw *= 0.3;
                ggAdjusted.push(gw);
            }
            var ggNorm = normalizeWeights(ggAdjusted);
            var ggRaw = weightedMean(ggValuesPresent, ggNorm);
            ggOut = ggRaw == null ? ggMinForCountry : Math.max(Math.round(ggRaw), ggMinForCountry);
        }

        // ---------- GR ----------
        var dottrina = getDottrinaNucleare(name);
        var grOut = null;
        if (dottrina.forza_null) {
            grOut = null;
        } else {
            var grBaseWeights = [0.4, 0.2, 0.4];
            var grValuesPresent = [];
            var grWeightsPresent = [];
            for (var vj = 0; vj < versions.length; vj++) {
                var grv = getNumberOrNull(versions[vj].gr);
                if (grv != null && grv > 0) {
                    grValuesPresent.push(grv);
                    grWeightsPresent.push(grBaseWeights[vj]);
                }
            }
            if (grValuesPresent.length === 0) {
                grOut = (ggOut != null) ? Math.round(ggOut * dottrina.min_ratio) : 3650;
            } else if (grValuesPresent.length === 1) {
                grOut = Math.round(grValuesPresent[0]);
            } else {
                var grMean = grValuesPresent.reduce(function (a, b) { return a + b; }, 0) / grValuesPresent.length;
                var grOutlierThreshold = Math.max(30, grMean * 0.5);
                var grAdjusted = [];
                for (var gk = 0; gk < grValuesPresent.length; gk++) {
                    var grw = grWeightsPresent[gk];
                    if (Math.abs(grValuesPresent[gk] - grMean) > grOutlierThreshold) grw *= 0.3;
                    grAdjusted.push(grw);
                }
                var grNorm = normalizeWeights(grAdjusted);
                var grRaw = weightedMean(grValuesPresent, grNorm);
                grOut = grRaw == null ? null : Math.round(grRaw);
            }

            // Vincolo dottrinale: GR >= GG * min_ratio
            if (ggOut != null && grOut != null) {
                var minGrDottrina = Math.round(ggOut * dottrina.min_ratio);
                if (grOut < minGrDottrina) grOut = minGrDottrina;
            }
        }

        var row = { nazione: name };
        if (ggOut != null) row.GG = ggOut;
        if (grOut != null) row.GR = grOut;
        out.push(row);

        console.log(
            '[VISION] V4 DEBUG | ' + name +
            ' | GG_in=' + JSON.stringify(ggInputsRaw) +
            ' | GR_in=' + JSON.stringify(grInputsRaw) +
            ' | GG_min=' + ggMinForCountry +
            ' | dottrina=' + JSON.stringify(dottrina) +
            ' | GG_out=' + (ggOut == null ? 'null' : ggOut) +
            ' | GR_out=' + (grOut == null ? 'null' : grOut)
        );
    }
    return out;
}

// Genera solo note.json (question_note da dataset selezionato), senza V_RED
async function updateSoloNote() {
    GLOBAL_ELAB_ABORTED = false; // richiesta esplicita Genera Note: non ereditare STOP precedente
    var promptNote = (config.prompts && config.prompts.question_note) || '';
    if (!promptNote) return null;
    var sourceDataset = getSharedQuestionDataset();
    var sentNote = sourceDataset.key + ':\n' + JSON.stringify(sourceDataset.data, null, 2);
    var elencoNazioni = getUniqueNazioniListForQuestionNote();
    sentNote += '\n\nElenco unico nazioni (Articoli_riassunto e sintesi_EMWA_Pesato_Sommato):\n' + (elencoNazioni.length ? elencoNazioni.join(', ') : '(nessuna)');
            console.log('');
    console.log('========== FASE question_note (solo note) ==========');
    console.log('[VISION] question_note -> User content (' + sourceDataset.file + ' allegato):');
    var noteMaxTokens = (typeof config.ai_deepseek_max_tokens_question_note === 'number' && config.ai_deepseek_max_tokens_question_note > 0)
        ? Math.floor(config.ai_deepseek_max_tokens_question_note) : 8192;
    noteMaxTokens = Math.min(Math.max(1, noteMaxTokens), 8192); // DeepSeek: valid range [1, 8192]
    var noteResponse = await callAI(promptNote, sentNote, { max_tokens: noteMaxTokens, stage: 'question_note' });
    if (typeof noteResponse === 'string' && noteResponse.indexOf('Error:') === 0) {
        console.error('[VISION] question_note: chiamata AI fallita - ' + noteResponse);
        return noteResponse;
    }
    recordQuestion('question_note', sentNote, noteResponse, { source: 'updateSoloNote', system: promptNote });
    var notesArray = parseNotesResponseFromIA(noteResponse);
    var numNotes = Array.isArray(notesArray) ? notesArray.length : 0;
    if (numNotes > 0) {
        var notesByNation = {};
        for (var ni = 0; ni < notesArray.length; ni++) {
            var it = notesArray[ni];
            if (!it || typeof it !== 'object') continue;
            var nn = it.nazione != null ? String(it.nazione).trim() : (it.nation != null ? String(it.nation).trim() : '');
            var notaIt = it.nota != null ? it.nota : it.note;
            var gaIt = it.GA != null ? it.GA : it.ga;
            if (!nn || typeof notaIt !== 'string') continue;
            var canon = nations.getCanonicalNameIfValid ? nations.getCanonicalNameIfValid(nn) : nn;
            if (!canon) continue;
            var obj = { nota: String(notaIt) };
            if (gaIt != null) obj.GA = gaIt;
            if (it.PercentualeCertezza != null && typeof it.PercentualeCertezza === 'number' && it.PercentualeCertezza >= 0 && it.PercentualeCertezza <= 100) obj.PercentualeCertezza = Math.round(it.PercentualeCertezza);
            if (it.Spiegazione != null && typeof it.Spiegazione === 'string' && it.Spiegazione.trim()) obj.Spiegazione = it.Spiegazione.trim();
            var promptVal = (it.Prompt != null && typeof it.Prompt === 'string' && it.Prompt.trim()) ? it.Prompt.trim() : (it.prompt != null && typeof it.prompt === 'string' && it.prompt.trim()) ? it.prompt.trim() : '';
            if (promptVal) obj.Prompt = promptVal;
            notesByNation[canon] = obj;
        }
        await writeJsonSerialized(NOTE_FILE, { byNation: notesByNation });
        console.log('[VISION] Note: ' + Object.keys(notesByNation).length + ' nazioni -> note.json');
        return { noteResponse, noteRequest: sentNote };
    }
    var preview = typeof noteResponse === 'string' ? noteResponse.trim().slice(0, 400) : String(noteResponse).slice(0, 400);
    console.error('[VISION] question_note parsing fallito (0 note). Anteprima risposta: ' + (preview || '(vuota)'));
    return 'Error: La risposta IA non contiene note valide (atteso array di oggetti con nazione, nota, GA). Riprova o controlla il prompt.';
}

async function updateNazioniSintesiAlternativa(requestOptions) {
    try {
        var questionNoteResponseOut = null;
        var questionNoteRequestOut = null;
        var questionNoteErrorOut = null;
        // nazionielaborate.json non più generato
        // NOTE e VRED eseguiti in sequenza (mai in parallelo) per evitare rate limit / risposte vuote dall'API.
        var sourceDataset = getSharedQuestionDataset();

        // question_note: usa dataset selezionato (Articoli_riassunto.json default, oppure EMWA_Pesato_Sommato.json)
        var promptNote = (config.prompts && config.prompts.question_note) || '';
        if (promptNote) {
            var sentNote = sourceDataset.key + ':\n' + JSON.stringify(sourceDataset.data, null, 2);
            var elencoNazioni = getUniqueNazioniListForQuestionNote();
            sentNote += '\n\nElenco unico nazioni (Articoli_riassunto e sintesi_EMWA_Pesato_Sommato):\n' + (elencoNazioni.length ? elencoNazioni.join(', ') : '(nessuna)');
            console.log('');
            console.log('========== FASE question_note (note nazioni) ==========');
            console.log('[VISION] question_note -> System prompt:');
            console.log('--- inizio system ---');
            console.log(promptNote);
            console.log('--- fine system ---');
            console.log('[VISION] question_note -> User content (' + sourceDataset.file + ' allegato):');
            console.log('--- inizio user ---');
            console.log(sentNote);
            console.log('--- fine user ---');
            var noteMaxTokens = (typeof config.ai_deepseek_max_tokens_question_note === 'number' && config.ai_deepseek_max_tokens_question_note > 0)
                ? Math.floor(config.ai_deepseek_max_tokens_question_note) : 8192;
            noteMaxTokens = Math.min(Math.max(1, noteMaxTokens), 8192); // DeepSeek: valid range [1, 8192]
            var noteResponse = await callAI(promptNote, sentNote, { max_tokens: noteMaxTokens, stage: 'question_note' });
            questionNoteRequestOut = sentNote;
            questionNoteResponseOut = noteResponse != null ? String(noteResponse) : null;
            if (typeof noteResponse === 'string' && noteResponse.indexOf('Error:') === 0) {
                questionNoteErrorOut = noteResponse;
                console.error('[VISION] question_note: chiamata AI fallita - ' + noteResponse);
            } else {
            recordQuestion('question_note', sentNote, noteResponse, { source: 'updateNazioniSintesiAlternativa', system: promptNote });
            
            // --- LOG PER INTERFACCIA WEB (Se attivato log_show_questions/responses) ---
            console.log('[VISION] question_note -> User content inviato:');
            console.log(sentNote);
            console.log('[VISION] question_note -> Risposta IA ricevuta:');
            console.log(typeof noteResponse === 'string' ? noteResponse : JSON.stringify(noteResponse));
            // --------------------------------------------------------------------------

            console.log('[VISION] Risposta IA (question_note):');
            console.log('--- inizio risposta ---');
            console.log(typeof noteResponse === 'string' ? noteResponse : JSON.stringify(noteResponse));
            console.log('--- fine risposta ---');
            var notesArray = parseNotesResponseFromIA(noteResponse);
            var numNotes = Array.isArray(notesArray) ? notesArray.length : 0;
            if (numNotes > 0) {
                // Converte l'array [{nazione, nota, GA}] in mappa byNation per il file note.json
                var notesByNation = {};
                for (var ni = 0; ni < notesArray.length; ni++) {
                    var it = notesArray[ni];
                    if (!it || typeof it !== 'object') continue;
                    var nn = it.nazione != null ? String(it.nazione).trim() : (it.nation != null ? String(it.nation).trim() : '');
                    var notaIt = it.nota != null ? it.nota : it.note;
                    var gaIt = it.GA != null ? it.GA : it.ga;
                    if (!nn || typeof notaIt !== 'string') continue;
                    var canon = nations.getCanonicalNameIfValid ? nations.getCanonicalNameIfValid(nn) : nn;
                    if (!canon) continue;
                    var obj = { nota: String(notaIt) };
                    if (gaIt != null) obj.GA = gaIt;
                    if (it.PercentualeCertezza != null && typeof it.PercentualeCertezza === 'number' && it.PercentualeCertezza >= 0 && it.PercentualeCertezza <= 100) obj.PercentualeCertezza = Math.round(it.PercentualeCertezza);
                    if (it.Spiegazione != null && typeof it.Spiegazione === 'string' && it.Spiegazione.trim()) obj.Spiegazione = it.Spiegazione.trim();
                    var promptValAlt = (it.Prompt != null && typeof it.Prompt === 'string' && it.Prompt.trim()) ? it.Prompt.trim() : (it.prompt != null && typeof it.prompt === 'string' && it.prompt.trim()) ? it.prompt.trim() : '';
                    if (promptValAlt) obj.Prompt = promptValAlt;
                    notesByNation[canon] = obj;
                }
                await writeJsonSerialized(NOTE_FILE, { byNation: notesByNation });
                console.log('[VISION] Note: ' + Object.keys(notesByNation).length + ' nazioni -> note.json');
            } else {
                questionNoteErrorOut = 'Parsing question_note fallito (0 note).';
                console.error('[VISION] ' + questionNoteErrorOut + ' Mantengo ultimo note.json valido.');
            }
            }
        }

        // FASE V_RED: eseguita dopo question_note (sequenza, non parallelo) con breve pausa per ridurre rischio risposta vuota
        var vRedResponseOut = null;
        var vRedResult = null;
        var promptRed = (config.prompts && config.prompts.question_RED) || '';
        if (promptRed) {
            console.log('');
            var payloadRed = sourceDataset.key + ':\n' + JSON.stringify(sourceDataset.data, null, 2);
            console.log('========== FASE V_RED (messaggio finale da ' + sourceDataset.file + ') ==========');
            console.log('[VISION] question_RED -> INVIO COMPLETO (domanda + ' + sourceDataset.key + '):');
            console.log('--- inizio user ---');
            console.log('=== DOMANDA (system prompt) ===\n' + promptRed + '\n\n=== USER CONTENT (' + sourceDataset.key + ') ===\n' + payloadRed);
            console.log('--- fine user ---');
            console.log('[VISION] question_RED -> Domanda (system prompt):');
            console.log('--- inizio user ---');
            console.log(promptRed);
            console.log('--- fine user ---');
            console.log('[VISION] question_RED -> User content (' + sourceDataset.file + ' allegato).');
            console.log('--- inizio user ---');
            console.log(payloadRed);
            console.log('--- fine user ---');
            var maxTokensRed = (typeof config.ai_deepseek_max_tokens_question_red === 'number' && config.ai_deepseek_max_tokens_question_red > 0)
                ? Math.floor(config.ai_deepseek_max_tokens_question_red)
                : 4000;
            await new Promise(function (r) { setTimeout(r, 2500); });
            var redResp = await callAI(promptRed, payloadRed, { max_tokens: maxTokensRed });
            vRedResponseOut = redResp != null ? String(redResp).trim() : null;
            console.log('[VISION] Risposta IA (question_RED):');
            console.log('--- inizio risposta ---');
            console.log(vRedResponseOut != null ? String(vRedResponseOut) : '');
            console.log('--- fine risposta ---');
            recordQuestion('question_RED', payloadRed, vRedResponseOut, { source: 'updateNazioniSintesiAlternativa', system: promptRed });
            var redData = null;
            var s = vRedResponseOut != null ? String(vRedResponseOut).trim() : '';
            try {
                var m = s.match(/```(?:json)?\\s*([\\s\\S]*?)```/);
                if (m) s = m[1].trim();
                var parsed = JSON.parse(s);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    redData = parsed[0];
                } else if (parsed && typeof parsed === 'object') {
                    redData = parsed;
                }
            } catch (e) {
                console.warn('[VISION] question_RED: errore parse JSON risposta (provo fallback):', e.message);
            }
            if (!redData) {
                // Fallback: risposta tipo [{\"messaggio\", \"giorni\"}] senza chiavi
                try {
                    // Estrae tutte le stringhe tra virgolette
                    var parts = [];
                    var re = /"([^"]+)"/g;
                    var m2;
                    while ((m2 = re.exec(s)) !== null) {
                        parts.push(m2[1]);
                    }
                    if (parts.length >= 1) {
                        var msg = parts[0];
                        var giorniVal = null;
                        if (parts.length >= 2 && /^\\d+$/.test(parts[1])) {
                            giorniVal = parseInt(parts[1], 10);
                        }
                        redData = { Messaggio: msg, Giorni: isNaN(giorniVal) ? null : giorniVal };
                    }
                } catch (_) {
                    // ignora, redData resterà null
                }
            }
            if (redData && typeof redData === 'object') {
                var pct = redData['Percentuale di certezza'] != null ? redData['Percentuale di certezza'] : redData.PercentualeCertezza;
                if (typeof pct !== 'number') {
                    var n = parseInt(String(pct).trim(), 10);
                    pct = (isFinite(n) && n >= 0 && n <= 100) ? n : null;
                } else if (pct < 0 || pct > 100) pct = null;
                var promptFeedback = redData.prompt != null && typeof redData.prompt === 'string'
                    ? redData.prompt.trim()
                    : '';
                vRedResult = {
                    Messaggio: redData.Messaggio != null ? String(redData.Messaggio) : '',
                    Giorni: redData.Giorni != null ? redData.Giorni : null,
                    PercentualeCertezza: pct,
                    Spiegazione: redData.Spiegazione != null && typeof redData.Spiegazione === 'string' ? redData.Spiegazione.trim() : '',
                    Prompt: promptFeedback
                };
                await writeJsonSerialized(SINTESI_VRED_FILE, vRedResult);
                console.log('[VISION] FASE V_RED completata: Messaggio, Giorni, PercentualeCertezza e Spiegazione -> sintesiVRED.json');
            } else {
                if (!vRedResponseOut) {
                    console.warn('[VISION] question_RED: risposta IA vuota (pipeline), sintesiVRED.json non sovrascritto.');
                } else {
                    console.warn('[VISION] question_RED non ha prodotto JSON valido con \"Messaggio\" e \"Giorni\". sintesiVRED.json non sovrascritto.');
                }
            }
        }

        return {
            question_note: questionNoteResponseOut,
            question_note_request: questionNoteRequestOut,
            question_note_error: questionNoteErrorOut,
            vred_response: vRedResponseOut,
            sintesi_vred: vRedResult
        };
    } catch (e) {
        console.error('updateNazioniSintesiAlternativa error:', e.message);
        return null;
    }
}

// V6 disabilitato: la funzione di aggiornamento è mantenuta solo come stub per compatibilità API
async function updateSintesiNazioniElaborateIA() {
    console.log('[VISION] FASE V6 disabilitata: sintesiNazioniElaborate_IA.json non viene più generato.');
    sintesiNazioniElabIaRawArray = [];
    return { success: true, count: 0, ai_response: null };
}

// Tenta di riparare JSON troncato (es. risposta IA tagliata a metà stringa): chiude stringhe/oggetti/array aperti
function tryRepairTruncatedNotesJson(str) {
    if (!str || typeof str !== 'string') return null;
    var s = str.trim();
    if (s.indexOf('[') !== 0) return null;
    try {
        var stack = [], inStr = false, strCh = '', i = 0;
        while (i < s.length) {
            var c = s[i];
            if (!inStr) {
                if (c === '[') stack.push(']');
                else if (c === '{') stack.push('}');
                else if (c === ']' || c === '}') { if (stack.length > 0 && stack[stack.length - 1] === c) stack.pop(); }
                else if ((c === '"' || c === "'") && (i === 0 || s[i - 1] !== '\\')) { inStr = true; strCh = c; }
            } else if (c === strCh && (i === 0 || s[i - 1] !== '\\')) inStr = false;
            i++;
        }
        var suffix = inStr ? strCh : '';
        while (stack.length > 0) suffix += stack.pop();
        var repaired = s + suffix;
        var parsed = JSON.parse(repaired);
        return Array.isArray(parsed) ? parsed : null;
    } catch (_) { return null; }
}

// Estrae oggetti completi {"nazione":"...","nota":"..."} da una stringa (anche troncata); la nota può contenere virgolette escaped
function extractCompleteNoteObjects(str) {
    if (!str || typeof str !== 'string') return [];
    var s = str.trim();
    var start = s.indexOf('[');
    if (start === -1) return [];
    var out = [];
    var i = start + 1;
    while (i < s.length) {
        var objStart = s.indexOf('{', i);
        if (objStart === -1) break;
        var depth = 0;
        var inStr = false;
        var strCh = '';
        var j = objStart;
        while (j < s.length) {
            var c = s[j];
            if (!inStr) {
                if (c === '{') depth++;
                else if (c === '}') {
                    depth--;
                    if (depth === 0) {
                        try {
                            var obj = JSON.parse(s.substring(objStart, j + 1));
                            if (obj && (obj.nazione || obj.nation) && (obj.nota != null || obj.note != null)) out.push(obj);
                        } catch (_) {}
                        i = j + 1;
                        break;
                    }
                } else if (c === '"' || c === "'") { inStr = true; strCh = c; }
            } else {
                if (c === '\\') { j++; if (j < s.length) j++; continue; }
                if (c === strCh) inStr = false;
            }
            j++;
        }
        if (depth !== 0) break;
        i = j;
    }
    return out;
}

function parseNotesResponseFromIA(aiResponse) {
    var data = null;
    if (typeof aiResponse === 'string') {
        var s = aiResponse.trim();
        var jsonMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) s = jsonMatch[1].trim();
        else if (s.indexOf('```') === 0) {
            s = s.replace(/^```(?:json)?\s*\n?/, '').trim();
        }
        try {
            data = JSON.parse(s);
        } catch (_) {
            data = extractFirstJsonArray(s) || extractFirstJsonObject(s);
        }
        if (!data && (s.indexOf('[') !== -1 || s.indexOf('{') !== -1)) {
            var arrFromText = extractCompleteNoteObjects(s);
            if (arrFromText.length > 0) data = arrFromText;
        }
        if (!data && s.indexOf('[') === 0) {
            var repaired = tryRepairTruncatedNotesJson(s);
            if (repaired && Array.isArray(repaired) && repaired.length > 0) data = repaired;
        }
    } else if (aiResponse && typeof aiResponse === 'object') {
        data = aiResponse;
    }
    if (!data) return [];
    var arr = Array.isArray(data) ? data : (data.nazioni || data.notes || []);
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        var item = arr[i];
        if (!item || typeof item !== 'object') continue;
        var n = (item.nazione != null ? item.nazione : item.nation);
        var nota = (item.nota != null ? item.nota : item.note);
        var gaRaw = (item.GA != null ? item.GA : item.ga);
        if (!n || typeof nota !== 'string') continue;
        var nn = nations.getCanonicalNameIfValid ? nations.getCanonicalNameIfValid(String(n).trim()) : String(n).trim();
        if (!nn) continue;
        var gaVal = null;
        if (gaRaw != null) {
            var gaText = String(gaRaw).trim();
            if (gaText) gaVal = gaText;
        }
        var clean = { nazione: nn, nota: String(nota) };
        if (gaVal != null) clean.GA = gaVal;
        var pct = item['Percentuale di certezza'] != null ? item['Percentuale di certezza'] : item.PercentualeCertezza;
        if (typeof pct === 'number' && pct >= 0 && pct <= 100) { clean.PercentualeCertezza = Math.round(pct); } else if (pct != null) { var n = parseInt(String(pct).trim(), 10); if (isFinite(n) && n >= 0 && n <= 100) clean.PercentualeCertezza = n; }
        if (item.Spiegazione != null && typeof item.Spiegazione === 'string' && item.Spiegazione.trim()) clean.Spiegazione = item.Spiegazione.trim();
        var promptVal = item.prompt != null ? item.prompt : item.Prompt;
        if (promptVal != null && typeof promptVal === 'string' && promptVal.trim()) clean.Prompt = promptVal.trim();
        out.push(clean);
    }
    return out;
}

function readNoteFromFile() {
    var data = readJsonObject(NOTE_FILE, null);
    var byNation = {};
    var byCode = {};
    if (!data) return { byNation: byNation, byCode: byCode };

    // Nuovo formato: array di { nazione, nota, GA }
    if (Array.isArray(data)) {
        for (var i = 0; i < data.length; i++) {
            var item = data[i];
            if (!item || typeof item !== 'object') continue;
            var n = item.nazione != null ? item.nazione : item.nation;
            var nota = item.nota != null ? item.nota : item.note;
            var ga = item.GA != null ? item.GA : item.ga;
            if (!n || typeof nota !== 'string') continue;
            var nn = nations.getCanonicalNameIfValid ? nations.getCanonicalNameIfValid(String(n).trim()) : String(n).trim();
            if (!nn) continue;
            var noteObj = { nazione: nn, nota: String(nota) };
            if (ga != null) noteObj.GA = ga;
            var pctItem = item['Percentuale di certezza'] != null ? item['Percentuale di certezza'] : item.PercentualeCertezza;
            if (typeof pctItem === 'number' && pctItem >= 0 && pctItem <= 100) noteObj.PercentualeCertezza = Math.round(pctItem);
            else if (pctItem != null) { var nPct = parseInt(String(pctItem).trim(), 10); if (isFinite(nPct) && nPct >= 0 && nPct <= 100) noteObj.PercentualeCertezza = nPct; }
            if (item.Spiegazione != null && typeof item.Spiegazione === 'string' && item.Spiegazione.trim()) noteObj.Spiegazione = item.Spiegazione.trim();
            var promptItem = item.Prompt != null ? item.Prompt : item.prompt;
            if (promptItem != null && typeof promptItem === 'string' && promptItem.trim()) noteObj.Prompt = promptItem.trim();
            byNation[nn] = noteObj;
            var code = nations.getNationIsoCode ? nations.getNationIsoCode(nn) : null;
            if (code) byCode[String(code).toLowerCase()] = noteObj;
        }
        return { byNation: byNation, byCode: byCode };
    }

    // Formato oggetto: { byNation, ... } con nota semplice o oggetto { nota, GA }
    if (data && typeof data === 'object') {
        var srcByNation = data.byNation || {};
        for (var k in srcByNation) {
            if (!srcByNation.hasOwnProperty(k)) continue;
            var v = srcByNation[k];
            var notaVal = null;
            var gaVal2 = null;
            var spiegVal = null;
            var pctVal = null;
            if (v && typeof v === 'object') {
                if (v.nota != null) notaVal = v.nota;
                else if (v.note != null) notaVal = v.note;
                if (v.GA != null) gaVal2 = v.GA;
                else if (v.ga != null) gaVal2 = v.ga;
                if (v.Spiegazione != null && typeof v.Spiegazione === 'string') spiegVal = v.Spiegazione.trim();
                var pctRaw = v['Percentuale di certezza'] != null ? v['Percentuale di certezza'] : v.PercentualeCertezza;
                if (typeof pctRaw === 'number' && pctRaw >= 0 && pctRaw <= 100) pctVal = Math.round(pctRaw);
                else if (pctRaw != null) { var np = parseInt(String(pctRaw).trim(), 10); if (isFinite(np) && np >= 0 && np <= 100) pctVal = np; }
            } else if (typeof v === 'string') {
                notaVal = v;
            }
            var promptVal2 = (v && (v.Prompt != null || v.prompt != null)) ? (v.Prompt != null ? v.Prompt : v.prompt) : null;
            if (typeof promptVal2 !== 'string') promptVal2 = null; else promptVal2 = promptVal2.trim() || null;
            if (typeof notaVal !== 'string') continue;
            var nn2 = nations.getCanonicalNameIfValid ? nations.getCanonicalNameIfValid(String(k).trim()) : String(k).trim();
            if (!nn2) continue;
            var noteObj2 = { nazione: nn2, nota: String(notaVal) };
            if (gaVal2 != null) noteObj2.GA = gaVal2;
            if (pctVal != null) noteObj2.PercentualeCertezza = pctVal;
            if (spiegVal) noteObj2.Spiegazione = spiegVal;
            if (promptVal2) noteObj2.Prompt = promptVal2;
            byNation[nn2] = noteObj2;
            var code2 = nations.getNationIsoCode ? nations.getNationIsoCode(nn2) : null;
            if (code2) byCode[String(code2).toLowerCase()] = noteObj2;
        }
        return { byNation: byNation, byCode: byCode };
    }

    return { byNation: byNation, byCode: byCode };
}

// A avvio server: carica sintesi esistenti da sintesi_EMWA_Pesato_Sommato.json (V1 deprecato)
try {
    if (fs.existsSync(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE)) {
        var dataSintesiPesato = readJsonObject(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE, null);
        var parsedSintesiPesato = parseSintesiResponseFromIA(dataSintesiPesato);
        nazioniSintesi = { byNation: parsedSintesiPesato.byNation || {}, byCode: parsedSintesiPesato.byCode || {} };
        if (Object.keys(nazioniSintesi.byNation || {}).length > 0) {
            console.log('[VISION] Sintesi nazioni caricate da sintesi_EMWA_Pesato_Sommato.json all\'avvio.');
        }
    }
} catch (e) {
    console.error('[VISION] Caricamento sintesi_EMWA_Pesato_Sommato.json all\'avvio:', e.message);
}

// API: sintesi per nazione (per popup mappa) — ora legge sintesi_EMWA_Pesato_Sommato.json
app.get('/api/nazioni-sintesi', (req, res) => {
    try {
        var data = readJsonObject(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE, null);
        var parsed = parseSintesiResponseFromIA(data);
        nazioniSintesi = { byNation: parsed.byNation || {}, byCode: parsed.byCode || {} };
        res.json(nazioniSintesi);
    } catch (e) {
        console.error('[VISION] /api/nazioni-sintesi error:', e.message);
        res.json({ byNation: {}, byCode: {} });
    }
});

// API: sintesi alternativa (stima IA) — legge sintesialternativa.json
app.get('/api/nazioni-sintesi-alternativa', (req, res) => {
    res.json(readSintesiAlternativaFromFile());
});

// API: sintesi V_RED (messaggio globale di rischio) — legge sintesiVRED.json
app.get('/api/sintesi-vred', (req, res) => {
    try {
        var data = readJsonObject(SINTESI_VRED_FILE, null) || {};
        res.json(data);
    } catch (e) {
        res.json({});
    }
});

// API: invio email riassunto (cartella attiva, VRed, note) leggendo SOLO i JSON locali
app.post('/api/send-email-riassunto', async (req, res) => {
    try {
        var folderLabel = activeJsonSubdir && activeJsonSubdir.trim() ? activeJsonSubdir.trim() : 'Principale';
        
        // 1. Leggi sintesi VRED
        var vredData = readJsonObject(SINTESI_VRED_FILE, {});
        var vredMsgRaw = (vredData && vredData.Messaggio != null) ? String(vredData.Messaggio).trim() : '';
        var vredDaysRaw = (vredData && vredData.Giorni != null && String(vredData.Giorni).trim() !== '') ? String(vredData.Giorni).trim() : '';
        var vredPctRaw = (vredData && (vredData.PercentualeCertezza != null || vredData['Percentuale di certezza'] != null))
            ? String(vredData.PercentualeCertezza != null ? vredData.PercentualeCertezza : vredData['Percentuale di certezza']).trim()
            : '';
        var hasVredContent = !!(vredMsgRaw || vredDaysRaw || vredPctRaw);
        var vredMsg = vredMsgRaw || "Nessun avviso globale disponibile.";
        var vredDays = vredDaysRaw ? (vredDaysRaw + " giorni") : "N/A";
        var vredPct = vredPctRaw ? (vredPctRaw + "%") : "N/A";

        // 2. Leggi Note
        var noteData = readJsonObject(NOTE_FILE, {});
        var byNation = noteData.byNation || {};
        
        // 3. Leggi conteggio articoli
        var articlesData = readJson(ARTICOLI_ELABORATI_FILE);
        var articlesCount = Array.isArray(articlesData) ? articlesData.length : 0;
        
        // 4. Leggi Template
        var templatePath = path.join(__dirname, 'public', 'email_template.html');
        if (fs.existsSync(templatePath)) {
            var html = fs.readFileSync(templatePath, 'utf8');
            
            // Replace VRED
            html = html.replace('{{URGENT_MESSAGE}}', vredMsg);
            html = html.replace('{{URGENT_DAYS}}', vredDays);
            html = html.replace('{{URGENT_PERCENTAGE}}', vredPct);
            
            // Replace Stats
            html = html.replace('{{ARTICLES_COUNT}}', String(articlesCount));
            var nations = Object.keys(byNation).sort();
            var validNations = nations.filter(function (n) {
                var obj = byNation[n];
                if (!obj) return false;
                if (typeof obj === 'string') return String(obj).trim() !== '';
                if (typeof obj === 'object') {
                    var nota = obj.nota != null ? String(obj.nota).trim() : '';
                    var note = obj.note != null ? String(obj.note).trim() : '';
                    return !!(nota || note);
                }
                return false;
            });
            var nationsCount = validNations.length;
            html = html.replace('{{NATIONS_COUNT}}', String(nationsCount));

            if (!hasVredContent && validNations.length === 0) {
                return res.json({ ok: false, skipped: true, reason: 'empty_vred_notes', message: 'VRed e Note vuoti: email non inviata.' });
            }

            // Build Articles List
            var listHtml = '';
            var textLines = [];
            var nationBlocks = [];
            textLines.push('Vision - Report ' + folderLabel);
            if (hasVredContent) {
                textLines.push('');
                textLines.push('AVVISO URGENTE: ' + vredMsg);
                if (vredDaysRaw) textLines.push('Finestra temporale: ' + vredDays);
                if (vredPctRaw) textLines.push('Attendibilità: ' + vredPct);
            }

            if (validNations.length === 0) {
                 listHtml = '<tr><td style="padding: 15px 0; color: #888;">Nessuna nota rilevante disponibile.</td></tr>';
            } else {
                for (var i = 0; i < validNations.length; i++) {
                    var nn = validNations[i];
                    var obj = byNation[nn];
                    var notaText = '';
                    var gaVal = '';
                    
                    if (typeof obj === 'object') {
                        notaText = obj.nota || obj.note || '';
                        gaVal = (obj.GA != null) ? String(obj.GA) : ((obj.ga != null) ? String(obj.ga) : '');
                    } else if (typeof obj === 'string') {
                        notaText = obj;
                    }
                    
                    if (!notaText) continue;

                    var gaLine = gaVal ? gaVal : 'Analisi Vision AI';

                    var notaTrimmed = notaText.replace(/\s+/g, ' ').trim();
                    textLines.push('');
                    textLines.push(nn + ' — ' + gaLine);
                    textLines.push(notaTrimmed);
                    nationBlocks.push({ nn: nn, gaLine: gaLine, notaText: notaTrimmed });

                    listHtml += `
                                <tr>
                                    <td style="padding: 15px 0; border-bottom: 1px solid #2f2f2f;">
                                        <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                            <tr>
                                                <td style="padding-bottom: 5px;">
                                                    <span style="font-size: 16px; font-weight: 600; color: #e5e5e5;">${nn}</span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding-bottom: 8px;">
                                                    <span style="font-size: 12px; color: #9aa0a6;">${gaLine}</span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="color: #cfcfcf; font-size: 13px; line-height: 1.5;">
                                                    ${notaText}
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>`;
                }
            }
            
            html = html.replace('{{ARTICLES_LIST}}', listHtml);

            textLines.push('');
            textLines.push('Articoli analizzati: ' + String(articlesCount));
            textLines.push('Nazioni coinvolte: ' + String(nationsCount));
            var telegramText = textLines.join('\n');

            // Calcola numero progressivo email a partire dalle impostazioni cartella
            var rawSettings = readJsonObject(FOLDER_SETTINGS_FILE, null);
            var settings = normalizeFolderSettings(rawSettings);
            var currentProgressivo = (settings && typeof settings.email_progressivo === 'number' && settings.email_progressivo >= 0)
                ? settings.email_progressivo
                : 0;
            var nextProgressivo = currentProgressivo + 1;

            // Messaggio Telegram in HTML: stile simile all'email (grassetto/corsivo/code + emoji al posto colori)
            var telegramHtml = '';
            telegramHtml += '<b>Vision AI</b>\n';
            telegramHtml += '<i>📋 Daily Report — ' + escapeTelegramHtml(folderLabel) + ' #' + nextProgressivo + '</i>\n\n';
            if (hasVredContent) {
                telegramHtml += '<b>⚠️ AVVISO URGENTE</b>\n';
                telegramHtml += escapeTelegramHtml(vredMsg) + '\n';
                if (vredDaysRaw) telegramHtml += '⏱ Finestra temporale: ' + escapeTelegramHtml(vredDays) + '\n';
                if (vredPctRaw) telegramHtml += '✅ Attendibilità: ' + escapeTelegramHtml(vredPct) + '\n\n';
            }
            telegramHtml += '<b><u>📌 SINTESI ANALISI</u></b>\n';
            telegramHtml += '────────────────\n\n';
            for (var nb = 0; nb < nationBlocks.length; nb++) {
                var blk = nationBlocks[nb];
                telegramHtml += '<b>' + escapeTelegramHtml(blk.nn) + '</b>\n';
                telegramHtml += '<i>' + escapeTelegramHtml(blk.gaLine) + '</i>\n';
                telegramHtml += escapeTelegramHtml(blk.notaText) + '\n\n';
            }
            telegramHtml += '────────────────\n';
            telegramHtml += 'Articoli analizzati: <code>' + String(articlesCount) + '</code> · Nazioni coinvolte: <code>' + String(nationsCount) + '</code>';

            var subject = 'Vision - Report ' + folderLabel + ' #' + nextProgressivo;
            var recipientsInfo = getEmailRecipientsList();
            var emailRecipients = recipientsInfo.emailRecipients || [];
            var telegramRecipients = recipientsInfo.telegramRecipients || [];
            if (emailRecipients.length === 0 && telegramRecipients.length === 0) {
                return res.status(500).json({ ok: false, error: 'Nessun destinatario configurato (email o Telegram). Aggiungi indirizzi nella sezione Emails.' });
            }

            if (emailRecipients.length > 0) {
                var transporter = createMailTransport();
                if (!transporter) {
                    return res.status(500).json({ ok: false, error: 'Trasporto email non configurato.' });
                }
                var fromAddress = process.env.MAIL_FROM || process.env.MAIL_USER || 'vision@localhost';
                var toAddress = emailRecipients.map(function (item) {
                    if (!item || !item.address) return '';
                    var alias = item.alias ? String(item.alias).trim() : '';
                    if (!alias) return item.address;
                    var safeAlias = alias.replace(/"/g, "'");
                    return '"' + safeAlias + '" <' + item.address + '>';
                }).filter(Boolean).join(', ');

                await transporter.sendMail({
                    from: fromAddress,
                    to: toAddress,
                    subject: subject,
                    html: html 
                });
            }

            if (telegramRecipients.length > 0) {
                var tgToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
                if (!tgToken) {
                    console.warn('[VISION] TELEGRAM_BOT_TOKEN non configurato: skip invio Telegram.');
                } else {
                    var caption = subject.length > 1024 ? subject.substring(0, 1021) + '...' : subject;
                    var pngBuffer = null;
                    try {
                        pngBuffer = await renderHtmlToPng(html);
                    } catch (renderErr) {
                        console.warn('[VISION] Screenshot email non generato (fallback a messaggio testo):', renderErr && renderErr.message ? renderErr.message : String(renderErr));
                    }
                    if (pngBuffer && pngBuffer.length > 0) {
                        for (var ti = 0; ti < telegramRecipients.length; ti++) {
                            var rawChat = telegramRecipients[ti];
                            var chatId = String(rawChat && rawChat.address != null ? rawChat.address : '').trim();
                            if (!chatId) continue;
                            if (/^tg:/i.test(chatId)) chatId = chatId.replace(/^tg:/i, '');
                            if (/^telegram:/i.test(chatId)) chatId = chatId.replace(/^telegram:/i, '');
                            try {
                                var form = new FormData();
                                form.append('chat_id', chatId);
                                form.append('photo', pngBuffer, { filename: 'vision-report.png', contentType: 'image/png' });
                                form.append('caption', caption);
                                await axios.post('https://api.telegram.org/bot' + tgToken + '/sendPhoto', form, {
                                    headers: form.getHeaders(),
                                    timeout: 30000,
                                    maxBodyLength: Infinity,
                                    maxContentLength: Infinity
                                });
                                console.log('[VISION] Report Telegram (screenshot email) inviato a ' + chatId);
                            } catch (tgErr) {
                                console.warn('[VISION] Errore invio Telegram (foto) a ' + chatId + ': ' + (tgErr && tgErr.message ? tgErr.message : String(tgErr)));
                            }
                        }
                    } else {
                        var tgChunks = chunkTelegramHtml(telegramHtml, 4090);
                        for (var ti = 0; ti < telegramRecipients.length; ti++) {
                            var rawChat = telegramRecipients[ti];
                            var chatId = String(rawChat && rawChat.address != null ? rawChat.address : '').trim();
                            if (!chatId) continue;
                            if (/^tg:/i.test(chatId)) chatId = chatId.replace(/^tg:/i, '');
                            if (/^telegram:/i.test(chatId)) chatId = chatId.replace(/^telegram:/i, '');
                            try {
                                for (var tc = 0; tc < tgChunks.length; tc++) {
                                    await axios.post('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
                                        chat_id: chatId,
                                        text: tgChunks[tc],
                                        parse_mode: 'HTML'
                                    }, { timeout: 15000 });
                                }
                                console.log('[VISION] Report Telegram (testo) inviato a ' + chatId + (tgChunks.length > 1 ? ' (' + tgChunks.length + ' messaggi)' : ''));
                            } catch (tgErr) {
                                console.warn('[VISION] Errore invio Telegram a ' + chatId + ': ' + (tgErr && tgErr.message ? tgErr.message : String(tgErr)));
                            }
                        }
                    }
                }
            }
            
            // Aggiorna il progressivo email nelle impostazioni cartella
            try {
                var raw2 = readJsonObject(FOLDER_SETTINGS_FILE, null);
                var settings2 = normalizeFolderSettings(raw2);
                var base = (settings2 && typeof settings2.email_progressivo === 'number' && settings2.email_progressivo >= 0)
                    ? settings2.email_progressivo
                    : currentProgressivo;
                settings2.email_progressivo = base + 1;
                await writeJsonSerialized(FOLDER_SETTINGS_FILE, settings2);
            } catch (e2) {
                console.warn('[VISION] Impossibile aggiornare email_progressivo in folder-settings:', e2.message);
            }
            
            return res.json({ ok: true, recipients: { email: emailRecipients.map(function (it) { return it.address; }), telegram: telegramRecipients.map(function (it) { return it.address; }) }, email_progressivo: nextProgressivo });

        } else {
             return res.status(500).json({ ok: false, error: 'Template email non trovato.' });
        }

    } catch (e) {
        console.error('[VISION] Errore invio email riassunto:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// API: rigenera solo sintesi V_RED (chiamata IA question_RED)
app.post('/api/rigenera-sintesi-vred', async (req, res) => {
    try {
        GLOBAL_ELAB_ABORTED = false;
        var promptRed = (config.prompts && config.prompts.question_RED) || '';
        if (!promptRed) {
            return res.status(400).json({ ok: false, error: 'question_RED non configurato' });
        }
        var sourceDataset = getSharedQuestionDataset();
        var payloadRed = sourceDataset.key + ':\n' + JSON.stringify(sourceDataset.data, null, 2);
        console.log('[VISION] question_RED -> INVIO COMPLETO (domanda + ' + sourceDataset.key + '):');
        console.log('--- inizio user ---');
        console.log('=== DOMANDA (system prompt) ===\n' + promptRed + '\n\n=== USER CONTENT (' + sourceDataset.key + ') ===\n' + payloadRed);
        console.log('--- fine user ---');
        console.log('[VISION] question_RED -> Domanda (system prompt):');
        console.log('--- inizio user ---');
        console.log(promptRed);
        console.log('--- fine user ---');
        console.log('[VISION] question_RED -> User content (' + sourceDataset.file + ' allegato).');
        console.log('--- inizio user ---');
        console.log(payloadRed);
        console.log('--- fine user ---');
        var maxTokensRed = (typeof config.ai_deepseek_max_tokens_question_red === 'number' && config.ai_deepseek_max_tokens_question_red > 0)
            ? Math.floor(config.ai_deepseek_max_tokens_question_red) : 4000;
        var vRedResponseOut = await callAI(promptRed, payloadRed, { max_tokens: maxTokensRed });
        vRedResponseOut = vRedResponseOut != null ? String(vRedResponseOut).trim() : null;
        console.log('[VISION] Risposta IA (question_RED):');
        console.log('--- inizio risposta ---');
        console.log(vRedResponseOut != null ? String(vRedResponseOut) : '');
        console.log('--- fine risposta ---');
        recordQuestion('question_RED', payloadRed, vRedResponseOut, { source: 'rigenera-sintesi-vred', system: promptRed });
        if (!vRedResponseOut) {
            console.warn('[VISION] rigenera-sintesi-vred: risposta IA vuota, sintesiVRED.json non sovrascritto.');
            var existing = readJsonObject(SINTESI_VRED_FILE, null);
            return res.json({ ok: false, error: 'Risposta IA vuota per question_RED', sintesi_vred: existing });
        }
        var redData = null;
        var s = vRedResponseOut;
        try {
            var m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (m) s = m[1].trim();
            var parsed = JSON.parse(s);
            if (Array.isArray(parsed) && parsed.length > 0) redData = parsed[0];
            else if (parsed && typeof parsed === 'object') redData = parsed;
        } catch (e) { /* fallback sotto */ }
        if (!redData) {
            var parts = [];
            var re = /"([^"]+)"/g;
            var m2;
            while ((m2 = re.exec(s)) !== null) parts.push(m2[1]);
            if (parts.length >= 1) {
                var msg = parts[0];
                var giorniVal = parts.length >= 2 && /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : null;
                redData = { Messaggio: msg, Giorni: giorniVal };
            }
        }
        var vRedResult = null;
        if (redData && typeof redData === 'object') {
            var pct = redData['Percentuale di certezza'] != null ? redData['Percentuale di certezza'] : redData.PercentualeCertezza;
            if (typeof pct !== 'number') {
                var n = parseInt(String(pct).trim(), 10);
                pct = (isFinite(n) && n >= 0 && n <= 100) ? n : null;
            } else if (pct < 0 || pct > 100) pct = null;
            var promptFeedback = redData.prompt != null && typeof redData.prompt === 'string'
                ? redData.prompt.trim()
                : '';
            vRedResult = {
                Messaggio: redData.Messaggio != null ? String(redData.Messaggio) : '',
                Giorni: redData.Giorni != null ? redData.Giorni : null,
                PercentualeCertezza: pct,
                Spiegazione: redData.Spiegazione != null && typeof redData.Spiegazione === 'string' ? redData.Spiegazione.trim() : '',
                Prompt: promptFeedback
            };
            await writeJsonSerialized(SINTESI_VRED_FILE, vRedResult);
        } else {
            console.warn('[VISION] rigenera-sintesi-vred: risposta non parsabile, sintesiVRED.json non sovrascritto.');
            var existingAlt = readJsonObject(SINTESI_VRED_FILE, null);
            return res.json({ ok: false, error: 'Risposta IA non parsabile per question_RED', sintesi_vred: existingAlt });
        }
        res.json({ ok: true, sintesi_vred: vRedResult });
    } catch (e) {
        console.error('[VISION] rigenera-sintesi-vred error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// API: stima IA EMWA / V4 / V5 — DISABILITATE: restituiscono strutture vuote per compatibilità
app.get('/api/nazioni-emwa-ia', (req, res) => {
    res.json({ byNation: {}, byCode: {} });
});

app.get('/api/nazioni-sintesi-v4', (req, res) => {
    res.json({ byNation: {}, byCode: {} });
});

app.get('/api/nazioni-sintesi-v5', (req, res) => {
    res.json({ byNation: {}, byCode: {} });
});

// API: sintesi nazioni elaborate IA (V6) — DISABILITATA: restituisce struttura vuota
app.get('/api/nazioni-sintesi-elaborate-ia', (req, res) => {
    res.json({ byNation: {}, byCode: {} });
});

// API: note per nazione (generate con question_note dopo validazione) — legge note.json
app.get('/api/nazioni-note', (req, res) => {
    res.json(readNoteFromFile());
});

// API: genera solo note.json (question_note da Articoli_riassunto.json), senza V_RED
app.post('/api/elabora-solo-note', async (req, res) => {
    try {
        // Nuova richiesta esplicita: azzera eventuale STOP precedente
        GLOBAL_ELAB_ABORTED = false;
        var out = await updateSoloNote();
        if (typeof out === 'string' && out.indexOf('Error:') === 0) {
            return res.json({ success: false, error: out, note_response: out });
        }
        var noteResponse = out && out.noteResponse != null ? String(out.noteResponse) : null;
        var noteRequest = out && out.noteRequest != null ? String(out.noteRequest) : null;
        res.json({
            success: true,
            note_response: noteResponse,
            note_request: noteRequest
        });
    } catch (e) {
        console.error('elabora-solo-note error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// API: elabora sintesi alternativa (chiamata pipeline: genera note.json e sintesiVRED.json)
app.post('/api/elabora-sintesi-alternativa', async (req, res) => {
    try {
        // Nuova elaborazione sintetica (note + VRED): resetta STOP globale
        GLOBAL_ELAB_ABORTED = false;
        var bodyOpts = req.body && typeof req.body === 'object' ? req.body : {};
        var aiResult = await updateNazioniSintesiAlternativa(bodyOpts);
        var aiResponse = null;
        var noteResponse = null;
        var sintesiV4Count = 0;
        var sintesiV5Count = 0;
        var v5Response = null;
        var vRedResponse = null;
        var sintesiVRed = null;
        var noteRequest = null;
        var noteParseError = null;
        if (aiResult && typeof aiResult === 'object') {
            // question_validate / question_EMWA / final_summary_emwa deprecate
            noteResponse = aiResult.question_note != null ? String(aiResult.question_note) : null;
            noteRequest = aiResult.question_note_request != null ? String(aiResult.question_note_request) : null;
            noteParseError = aiResult.question_note_error != null ? String(aiResult.question_note_error) : null;
            sintesiV4Count = 0;
            sintesiV5Count = 0;
            v5Response = null;
            vRedResponse = aiResult.vred_response != null ? String(aiResult.vred_response) : null;
            sintesiVRed = aiResult.sintesi_vred || null;
        } else if (aiResult != null) {
            aiResponse = String(aiResult);
        }
        var altSuccess = !noteParseError;
        res.json({
            success: altSuccess,
            // sintesialternativa / sintesiEMWA / V4 / V5 disabilitate: i relativi campi restano per compatibilità ma vuoti
            count: 0,
            ai_response: null,
            emwa_response: null,
            final_summary_emwa_response: null,
            note_response: noteResponse,
            note_request: noteRequest,
            note_error: noteParseError,
            sintesi_v4_count: 0,
            sintesi_v5_count: 0,
            v5_response: null,
            vred_response: vRedResponse,
            sintesi_vred: sintesiVRed
        });
    } catch (e) {
        console.error('elabora-sintesi-alternativa error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// API: riordina articolielaborati.json (Data crescente, importanza articolo crescente). Da chiamare a fine popolamento da agenti asincroni.
app.post('/api/articolielaborati-sort', (req, res) => {
    try {
        sortArticolielaboratiByDateAndImportanza();
        res.json({ success: true });
    } catch (e) {
        console.error('articolielaborati-sort error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// API: elabora articolielaborati (rilegge JSON, chiama IA su EMWA_Pesato_Sommato)
app.post('/api/elabora-articolielaborati', async (req, res) => {
    try {
        sortArticolielaboratiByDateAndImportanza();
        var aiResponse = await updateNazioniSintesi();
        if (typeof aiResponse === 'string' && aiResponse.indexOf('Error:') === 0) {
            return res.json({
                success: false,
                error: aiResponse,
                count: 0,
                ai_response: aiResponse
            });
        }
        var data = readJsonObject(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE, null);
        var parsed = parseSintesiResponseFromIA(data);
        res.json({
            success: true,
            count: Object.keys(parsed.byNation || {}).length,
            ai_response: aiResponse != null ? String(aiResponse) : null
        });
    } catch (e) {
        console.error('elabora-articolielaborati error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// API: gestione cartelle JSON (sottocartelle dentro Json/)
app.get('/api/json-folders', (req, res) => {
    try {
        let entries = fs.readdirSync(ROOT_JSON_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort()
            .reverse(); // ordine decrescente (cartelle più recenti in alto)
        if (entries.length === 0) {
            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const defName = `${yyyy}-${mm}-${dd}`;
            const defPath = path.join(ROOT_JSON_DIR, defName);
            if (!fs.existsSync(defPath)) fs.mkdirSync(defPath, { recursive: true });
            entries = [defName];
        }
        // Se non c'è ancora una cartella attiva ma esistono cartelle, usa la prima come default e persisti la scelta
        if (!activeJsonSubdir && entries.length > 0) {
            activeJsonSubdir = entries[0];
            applyActiveJsonDir();
            try {
                fs.writeFileSync(ACTIVE_JSON_FOLDER_FILE, JSON.stringify({ active: activeJsonSubdir }, null, 2), 'utf8');
            } catch (_) {}
        }
        res.json({
            base: ROOT_JSON_DIR,
            active: activeJsonSubdir || '',
            folders: entries
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/json-folders/copy', (req, res) => {
    try {
        var from = (req.body && req.body.from != null) ? String(req.body.from).trim() : '';
        var to = (req.body && req.body.to != null) ? String(req.body.to).trim() : '';
        if (!from || !to) return res.status(400).json({ error: 'Parametri mancanti' });
        if (!/^[a-zA-Z0-9_\-]+$/.test(from) || !/^[a-zA-Z0-9_\-]+$/.test(to)) {
            return res.status(400).json({ error: 'Nome cartella non valido' });
        }
        var src = path.join(ROOT_JSON_DIR, from);
        var dst = path.join(ROOT_JSON_DIR, to);
        if (!fs.existsSync(src)) return res.status(404).json({ error: 'Cartella origine inesistente' });
        if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
        var files = fs.readdirSync(src, { withFileTypes: true }).filter(f => f.isFile());
        files.forEach(f => {
            var fromFile = path.join(src, f.name);
            var toFile = path.join(dst, f.name);
            fs.copyFileSync(fromFile, toFile);
        });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/json-folders/create', (req, res) => {
    try {
        var name = (req.body && req.body.name != null) ? String(req.body.name).trim() : '';
        if (!name) return res.status(400).json({ error: 'Nome cartella mancante' });
        if (!/^[a-zA-Z0-9_\-]+$/.test(name)) return res.status(400).json({ error: 'Nome cartella non valido' });
        var dirPath = path.join(ROOT_JSON_DIR, name);
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/json-folders/rename', (req, res) => {
    try {
        var from = (req.body && req.body.from != null) ? String(req.body.from).trim() : '';
        var to = (req.body && req.body.to != null) ? String(req.body.to).trim() : '';
        if (!from || !to) return res.status(400).json({ error: 'Parametri mancanti' });
        if (!/^[a-zA-Z0-9_\-]+$/.test(from) || !/^[a-zA-Z0-9_\-]+$/.test(to)) {
            return res.status(400).json({ error: 'Nome cartella non valido' });
        }
        var src = path.join(ROOT_JSON_DIR, from);
        var dst = path.join(ROOT_JSON_DIR, to);
        if (!fs.existsSync(src)) return res.status(404).json({ error: 'Cartella origine inesistente' });
        fs.renameSync(src, dst);
        if (activeJsonSubdir === from) {
            activeJsonSubdir = to;
            applyActiveJsonDir();
            try {
                fs.writeFileSync(ACTIVE_JSON_FOLDER_FILE, JSON.stringify({ active: activeJsonSubdir }, null, 2), 'utf8');
            } catch (_) {}
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/json-folders/delete', (req, res) => {
    try {
        var name = (req.body && req.body.name != null) ? String(req.body.name).trim() : '';
        if (!name) return res.status(400).json({ error: 'Nome cartella mancante' });
        if (!/^[a-zA-Z0-9_\-]+$/.test(name)) return res.status(400).json({ error: 'Nome cartella non valido' });
        var dirPath = path.join(ROOT_JSON_DIR, name);
        if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Cartella inesistente' });
        if (activeJsonSubdir === name) {
            activeJsonSubdir = '';
            applyActiveJsonDir();
            try {
                fs.writeFileSync(ACTIVE_JSON_FOLDER_FILE, JSON.stringify({ active: activeJsonSubdir }, null, 2), 'utf8');
            } catch (_) {}
        }
        fs.rmSync(dirPath, { recursive: true, force: true });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/json-folders/set-active', (req, res) => {
    try {
        var name = (req.body && req.body.name != null) ? String(req.body.name).trim() : '';
        if (name && !/^[a-zA-Z0-9_\-]+$/.test(name)) return res.status(400).json({ error: 'Nome cartella non valido' });
        if (name) {
            var dirPath = path.join(ROOT_JSON_DIR, name);
            if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        }
        activeJsonSubdir = name;
        applyActiveJsonDir();
        try {
            fs.writeFileSync(ACTIVE_JSON_FOLDER_FILE, JSON.stringify({ active: activeJsonSubdir }, null, 2), 'utf8');
        } catch (_) {}
        res.json({ ok: true, active: activeJsonSubdir });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Get URLs
app.get('/api/urls', (req, res) => {
    res.json(readJson(URLS_FILE));
});

// API: Save URLs
app.post('/api/urls', (req, res) => {
    const urls = req.body;
    writeJson(URLS_FILE, urls);
    res.json({ success: true });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const timeoutMs = config.ai_timeout_ms || 120000;
const AI_REQUEST_WATCHDOG_LOG_MS = 30000;
const AI_REQUEST_HARD_TIMEOUT_EXTRA_MS = 15000;
const DEEPSEEK_SAFE_CONCURRENCY_MAX = 10;
let aiRequestSeq = 0;

function applyAnalyzeConcurrencySetting(mc, sourceLabel) {
    if ([1, 10, 50, 100, 150].indexOf(mc) === -1) return;
    var desired = mc;
    if (config.TipoIA === 3 && desired > DEEPSEEK_SAFE_CONCURRENCY_MAX) {
        desired = DEEPSEEK_SAFE_CONCURRENCY_MAX;
        console.log('[VISION] max_concurrent ridotto per DeepSeek: richiesto=' + mc + ', applicato=' + desired + ' (' + (sourceLabel || 'n/d') + ')');
    }
    ANALYZE_ARTICLE_MAX = desired;
}

const doAIRequest = (url, headers, body, customTimeoutMs) => {
    var ms = (typeof customTimeoutMs === 'number' && customTimeoutMs > 0) ? customTimeoutMs : timeoutMs;
    var source = axios.CancelToken.source();
    var reqId = 'AI-' + (++aiRequestSeq);
    var startedAt = Date.now();
    var hardTimeoutMs = ms + AI_REQUEST_HARD_TIMEOUT_EXTRA_MS;
    console.log('[VISION][AI][' + reqId + '] START POST timeout=' + ms + 'ms hard=' + hardTimeoutMs + 'ms active=' + ACTIVE_AI_ABORT_CONTROLLERS.size);
    var controller = registerAiAbortController(function () {
        try { source.cancel('STOP richiesto'); } catch (_) {}
    });
    var watchdogTimer = setInterval(function () {
        var elapsed = Date.now() - startedAt;
        console.log('[VISION][AI][' + reqId + '] IN CORSO da ' + elapsed + 'ms (timeout=' + ms + 'ms, hard=' + hardTimeoutMs + 'ms)');
    }, AI_REQUEST_WATCHDOG_LOG_MS);
    var hardTimeoutTimer = setTimeout(function () {
        try { source.cancel('AI hard-timeout watchdog (' + hardTimeoutMs + 'ms)'); } catch (_) {}
    }, hardTimeoutMs);
    return axios.post(url, body, { timeout: ms, headers, cancelToken: source.token })
        .then(function (res) {
            console.log('[VISION][AI][' + reqId + '] OK in ' + (Date.now() - startedAt) + 'ms');
            return res;
        })
        .catch(function (err) {
            console.error('[VISION][AI][' + reqId + '] FAIL in ' + (Date.now() - startedAt) + 'ms:', err && err.message ? err.message : String(err));
            throw err;
        })
        .finally(function () {
            clearInterval(watchdogTimer);
            clearTimeout(hardTimeoutTimer);
            releaseAiAbortController(controller);
        });
};

const doAIGet = (url, headers, customTimeoutMs) => {
    var ms = (typeof customTimeoutMs === 'number' && customTimeoutMs > 0) ? customTimeoutMs : timeoutMs;
    var source = axios.CancelToken.source();
    var reqId = 'AI-' + (++aiRequestSeq);
    var startedAt = Date.now();
    var hardTimeoutMs = ms + AI_REQUEST_HARD_TIMEOUT_EXTRA_MS;
    console.log('[VISION][AI][' + reqId + '] START GET timeout=' + ms + 'ms hard=' + hardTimeoutMs + 'ms active=' + ACTIVE_AI_ABORT_CONTROLLERS.size);
    var controller = registerAiAbortController(function () {
        try { source.cancel('STOP richiesto'); } catch (_) {}
    });
    var watchdogTimer = setInterval(function () {
        var elapsed = Date.now() - startedAt;
        console.log('[VISION][AI][' + reqId + '] IN CORSO da ' + elapsed + 'ms (timeout=' + ms + 'ms, hard=' + hardTimeoutMs + 'ms)');
    }, AI_REQUEST_WATCHDOG_LOG_MS);
    var hardTimeoutTimer = setTimeout(function () {
        try { source.cancel('AI hard-timeout watchdog (' + hardTimeoutMs + 'ms)'); } catch (_) {}
    }, hardTimeoutMs);
    return axios.get(url, { timeout: ms, headers, cancelToken: source.token })
        .then(function (res) {
            console.log('[VISION][AI][' + reqId + '] OK in ' + (Date.now() - startedAt) + 'ms');
            return res;
        })
        .catch(function (err) {
            console.error('[VISION][AI][' + reqId + '] FAIL in ' + (Date.now() - startedAt) + 'ms:', err && err.message ? err.message : String(err));
            throw err;
        })
        .finally(function () {
            clearInterval(watchdogTimer);
            clearTimeout(hardTimeoutTimer);
            releaseAiAbortController(controller);
        });
};

const buildHeaders = (useDummy) => {
    const headers = { 'Content-Type': 'application/json' };
    if (config.ai_api_key && config.ai_api_key.trim()) {
        headers['Authorization'] = 'Bearer ' + config.ai_api_key.trim();
    } else if (useDummy || config.ai_use_dummy_auth) {
        headers['Authorization'] = 'Bearer no-key';
    }
    return headers;
};

const extractAIText = (response) => {
    if (response && response.data && response.data.choices && response.data.choices.length > 0) {
        const choice = response.data.choices[0];
        if (choice && choice.message && choice.message.content) return choice.message.content;
        if (choice && typeof choice.text === 'string') return choice.text;
    }
    return "No response from AI";
};

function getErrorPreview(err) {
    if (!err || !err.response) return '';
    var d = err.response.data;
    if (d === undefined || d === null) return '';
    return typeof d === 'string' ? d.slice(0, 500) : JSON.stringify(d).slice(0, 500);
}

function buildUserOnlyAiPayload(prompt, content) {
    var p = (prompt == null) ? '' : String(prompt).trim();
    var c = (content == null) ? '' : String(content);
    if (p && c) return p + '\n\n' + c;
    if (p) return p;
    return c;
}

// Cursor Cloud Agents API: https://cursor.com/docs/cloud-agent/api/endpoints — Basic Auth, lancia agent su repo, poll, leggi conversazione
function callAI_cursor_cloud_agents(prompt, content) {
    var fullMessage = buildUserOnlyAiPayload(prompt, content);
    console.log(fullMessage);
    var key = (config.ai_cursor_key && String(config.ai_cursor_key).trim()) ? String(config.ai_cursor_key).trim() : '';
    if (!key) return Promise.reject(new Error('API Key Cursor mancante. Imposta ai_cursor_key (chiave da https://cursor.com/settings).'));
    var repo = (config.ai_cursor_agent_repo && String(config.ai_cursor_agent_repo).trim()) ? String(config.ai_cursor_agent_repo).trim() : '';
    if (!repo || repo.indexOf('github.com') === -1) return Promise.reject(new Error('Per Cursor Cloud Agents imposta ai_cursor_agent_repo con l\'URL del repo GitHub (es. https://github.com/tuoutente/tuorepo).'));
    var ref = (config.ai_cursor_agent_ref && String(config.ai_cursor_agent_ref).trim()) ? String(config.ai_cursor_agent_ref).trim() : '';
    var auth = 'Basic ' + Buffer.from(key + ':').toString('base64');
    var headers = { 'Content-Type': 'application/json', 'Authorization': auth };
    var baseUrl = 'https://api.cursor.com/v0';
    var agentId;
    var source = { repository: repo };
    if (ref) source.ref = ref; 
    var body = {
        prompt: { text: fullMessage },
        source: source
    };
    var modelVal = (config.ai_cursor_model && String(config.ai_cursor_model).trim()) ? String(config.ai_cursor_model).trim() : '';
    if (modelVal && modelVal.toLowerCase() !== 'auto') {
        body.model = modelVal;
    }
    return doAIRequest(baseUrl + '/agents', headers, body, 60000)
        .then(function (res) {
            if (!res.data || !res.data.id) return Promise.reject(new Error('Cursor API: risposta senza id agent'));
            agentId = res.data.id;
            var pollUntil = Date.now() + (config.ai_timeout_ms || 120000);
            var pollInterval = 4000;
            function poll() {
                if (GLOBAL_ELAB_ABORTED) return Promise.reject(new Error('Elaborazione annullata dall\'utente (GLOBAL_ELAB_ABORTED).'));
                return doAIGet(baseUrl + '/agents/' + agentId, headers, 15000)
                    .then(function (r) {
                        var status = (r.data && r.data.status) ? r.data.status : '';
                        if (status === 'FINISHED') {
                            return doAIGet(baseUrl + '/agents/' + agentId + '/conversation', headers, 15000);
                        }
                        if (status === 'CREATING' || status === 'RUNNING') {
                            if (Date.now() >= pollUntil) return Promise.reject(new Error('Cursor agent: timeout in attesa di FINISHED'));
                            return sleep(pollInterval).then(poll);
                        }
                        return Promise.reject(new Error('Cursor agent stato inatteso: ' + status));
                    });
            }
            return poll();
        })
        .then(function (convRes) {
            var messages = (convRes.data && convRes.data.messages) ? convRes.data.messages : [];
            var parts = [];
            for (var i = 0; i < messages.length; i++) {
                if (messages[i].type === 'assistant_message' && messages[i].text) parts.push(messages[i].text);
            }
            return parts.length ? parts.join('\n\n') : 'No response from AI';
        });
}

// Cursor provider: usa Cloud Agents se configurato, altrimenti fallback non usato (config solo Cloud Agents)
function callAI_cursor(prompt, content) {
    if (config.ai_cursor_use_cloud_agents && config.ai_cursor_agent_repo) {
        return callAI_cursor_cloud_agents(prompt, content);
    }
    return Promise.reject(new Error('Configura ai_cursor_use_cloud_agents: true e ai_cursor_agent_repo (URL repo GitHub) in config.js. Vedi https://cursor.com/docs/cloud-agent/api/endpoints'));
}

// API online apifreellm.com: POST /api/v1/chat, body { message }, header Authorization: Bearer KEY
function callAI_apifreellm(prompt, content) {
    var fullMessage = buildUserOnlyAiPayload(prompt, content);
    var url = config.ai_online_url || 'https://apifreellm.com/api/v1/chat';
    var key = (config.ai_online_key && config.ai_online_key.trim()) ? config.ai_online_key.trim() : '';
    if (!key) return Promise.reject(new Error('API Key apifreellm mancante. Imposta ai_online_key in config.js o APIFREELLM_API_KEY.'));
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
    var body = { message: fullMessage };
    if (config.ai_model) body.model = config.ai_model;
    return doAIRequest(url, headers, body).then(function (res) {
        if (res.data && res.data.success && typeof res.data.response === 'string') return res.data.response;
        if (res.data && typeof res.data.response === 'string') return res.data.response;
        return "No response from AI";
    });
}

// DeepSeek API (TipoIA 3): OpenAI-compatible chat completions
// Limite contesto modello (token). Messaggi + max_tokens non devono superarlo.
var DEEPSEEK_MAX_CONTEXT_TOKENS = 131072;
// Stima caratteri per token (conservativa) per troncamento
var DEEPSEEK_CHARS_PER_TOKEN = 3.5;

function isDeepseekRetryableError(err) {
    if (!err) return false;
    var msg = String((err && err.message) || '').toLowerCase();
    var code = String((err && err.code) || '').toUpperCase();
    if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') return true;
    if (msg.indexOf('socket hang up') !== -1) return true;
    if (msg.indexOf('connect etimedout') !== -1) return true;
    if (msg.indexOf('network error') !== -1) return true;
    if (msg.indexOf('timeout') !== -1) return true;
    if (msg.indexOf('hard-timeout watchdog') !== -1) return true;
    return false;
}

// Suggerimenti DeepSeek: solo ruoli system/user/assistant/tool (mai "developer"), max_tokens conservativo, temperature opzionale
function callAI_deepseek(prompt, content, options) {
    var key = (config.ai_deepseek_key && String(config.ai_deepseek_key).trim()) ? String(config.ai_deepseek_key).trim() : '';
    if (!key) return Promise.reject(new Error('API Key DeepSeek mancante. Imposta ai_deepseek_key in config.js o DEEPSEEK_API_KEY.'));
    var url = (config.ai_deepseek_url && config.ai_deepseek_url.trim()) ? config.ai_deepseek_url.trim() : 'https://api.deepseek.com/v1/chat/completions';
    var opt = options && typeof options === 'object' ? options : {};
    var stage = (opt.stage && String(opt.stage).trim()) ? String(opt.stage).trim() : '';
    var requestedModel = (opt.model && String(opt.model).trim()) ? String(opt.model).trim() : '';
    var modelsByStage = (config.ai_deepseek_models_by_stage && typeof config.ai_deepseek_models_by_stage === 'object') ? config.ai_deepseek_models_by_stage : {};
    var baseChatModel = (config.ai_deepseek_model && config.ai_deepseek_model.trim()) ? config.ai_deepseek_model.trim() : 'deepseek-chat';
    var reasonerModel = (config.ai_deepseek_model_reasoner && config.ai_deepseek_model_reasoner.trim()) ? config.ai_deepseek_model_reasoner.trim() : baseChatModel;
    var forceChat = getForceDeepseekChatFromFolderSettings();
    var modelFromStage = stage && modelsByStage[stage] ? String(modelsByStage[stage]).trim() : '';
    var model;
    if (forceChat) {
        model = baseChatModel;
    } else {
        model = requestedModel || modelFromStage || reasonerModel || baseChatModel;
    }
    var requestedMaxTokens = (typeof opt.max_tokens === 'number' && opt.max_tokens > 0)
        ? Math.floor(opt.max_tokens)
        : ((typeof config.ai_deepseek_max_tokens === 'number' && config.ai_deepseek_max_tokens > 0) ? Math.floor(config.ai_deepseek_max_tokens) : 2000);
    var maxTokens = Math.min(Math.max(1, requestedMaxTokens), 8192); // DeepSeek: valid range [1, 8192]
    if (maxTokens !== requestedMaxTokens) {
        console.log('[MAX_TOKENS_TRUNCATED] DeepSeek max_tokens ridotto da ' + requestedMaxTokens + ' a ' + maxTokens + ' (limite 8192).');
    }
    var systemContent = '';
    var userContent = buildUserOnlyAiPayload(prompt, content);
    // Rispetta il limite contesto: messages + max_tokens <= DEEPSEEK_MAX_CONTEXT_TOKENS
    var maxMessageTokens = Math.max(1000, DEEPSEEK_MAX_CONTEXT_TOKENS - maxTokens);
    var maxMessageChars = Math.floor(maxMessageTokens * DEEPSEEK_CHARS_PER_TOKEN);
    var totalChars = (systemContent ? systemContent.length : 0) + (userContent ? userContent.length : 0);
    if (totalChars > maxMessageChars && userContent) {
        var keepChars = Math.max(1000, maxMessageChars - (systemContent ? systemContent.length : 0) - 80);
        userContent = userContent.substring(0, keepChars) + '\n\n[... testo troncato per limite contesto DeepSeek (max ' + String(DEEPSEEK_MAX_CONTEXT_TOKENS) + ' token) ...]';
        console.log('[DEEPSEEK_CONTEXT_TRUNCATED] DeepSeek contesto troncato: messaggi ridotti a ~' + keepChars + ' caratteri (limite ' + maxMessageChars + ')');
    }
    // Log modello usato per ogni chiamata DeepSeek
    console.log('[VISION][AI] DeepSeek model: ' + model + ' (stage=' + (stage || 'n/a') + ', max_tokens=' + maxTokens + ', force_chat=' + (forceChat ? 'on' : 'off') + ')');

    var body = {
        model: model,
        messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: userContent }
        ],
        stream: false,
        temperature: 0.7,
        max_tokens: maxTokens
    };
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
    var timeoutMs = (typeof opt.timeout_ms === 'number' && opt.timeout_ms > 0)
        ? Math.floor(opt.timeout_ms)
        : (config.ai_timeout_ms || 120000);
    if (!(typeof opt.timeout_ms === 'number' && opt.timeout_ms > 0) && stage === 'question_per_article') {
        timeoutMs = Math.max(timeoutMs, 140000);
    }
    var networkRetries = (typeof config.ai_deepseek_network_retries === 'number' && config.ai_deepseek_network_retries >= 0)
        ? Math.floor(config.ai_deepseek_network_retries)
        : 2;
    var retryBaseDelayMs = (typeof config.ai_deepseek_retry_delay_ms === 'number' && config.ai_deepseek_retry_delay_ms > 0)
        ? Math.floor(config.ai_deepseek_retry_delay_ms)
        : 2500;
    function extractTextFromDeepSeekResponse(res) {
        if (!(res && res.data && Array.isArray(res.data.choices) && res.data.choices.length > 0)) return '';
        var c = res.data.choices[0] || {};
        if (c.message) {
            if (typeof c.message.content === 'string') return c.message.content.trim();
            if (Array.isArray(c.message.content)) {
                var parts = [];
                for (var i = 0; i < c.message.content.length; i++) {
                    var p = c.message.content[i];
                    if (typeof p === 'string') parts.push(p);
                    else if (p && typeof p.text === 'string') parts.push(p.text);
                }
                return parts.join('\n').trim();
            }
        }
        if (typeof c.text === 'string') return c.text.trim();
        return '';
    }

    function requestWithRetry(modelName) {
        var attempt = 0;
        function runAttempt() {
            attempt++;
            var bodyAttempt = Object.assign({}, body, { model: modelName });
            return doAIRequest(url, headers, bodyAttempt, timeoutMs).catch(function (err) {
                if (GLOBAL_ELAB_ABORTED) throw err;
                if (!isDeepseekRetryableError(err) || attempt > networkRetries) throw err;
                var waitMs = retryBaseDelayMs * attempt;
                console.log('[VISION][AI] DeepSeek retry ' + attempt + '/' + networkRetries + ' model=' + modelName + ' tra ' + waitMs + 'ms (' + (err && err.message ? err.message : String(err)) + ')');
                return sleep(waitMs).then(runAttempt);
            });
        }
        return runAttempt().then(extractTextFromDeepSeekResponse);
    }

    function requestDeepseekChatFallback() {
        console.log('[VISION][AI] Fallback model -> deepseek-chat');
        return requestWithRetry('deepseek-chat').then(function (out2) {
            return out2 || 'No response from AI (empty content)';
        });
    }

    return requestWithRetry(model).then(function (out) {
        if (out) return out;
        if (String(model).toLowerCase().indexOf('reasoner') !== -1) {
            return requestDeepseekChatFallback();
        }
        return 'No response from AI (empty content)';
    }).catch(function (err) {
        if (String(model).toLowerCase().indexOf('reasoner') !== -1 && isDeepseekRetryableError(err)) {
            return requestDeepseekChatFallback();
        }
        throw err;
    });
}

// Resta in attesa: più tentativi con pause crescenti e timeout lungo per la risposta AI (GPT4All)
const callAI = async (prompt, content, options) => {
    // Se è stato richiesto uno STOP globale, interrompi subito la chiamata IA.
    if (GLOBAL_ELAB_ABORTED) {
        throw new Error('Elaborazione annullata dall\'utente (GLOBAL_ELAB_ABORTED).');
    }
    // TipoIA 1 = Cursor Cloud Agents
    if (config.TipoIA === 1) {
        try {
            console.log("Calling AI (Cursor)...");
            return await callAI_cursor(prompt, content);
        } catch (err) {
            console.error("AI cursor failed:", err.message);
            var status = err.response && err.response.status;
            var preview = getErrorPreview(err);
            if (err.code === 'ECONNREFUSED' || (err.message && err.message.indexOf('Network') !== -1)) {
                return "Error: Impossibile raggiungere Cursor API. Controlla connessione e ai_cursor_use_cloud_agents.";
            }
            if (status === 401) {
                return "Error: 401 - Chiave Cursor non valida o scaduta. Controlla ai_cursor_key (chiave da https://cursor.com/settings).";
            }
            if (status === 400) {
                var detail = getErrorPreview(err);
                console.error("[VISION] Cursor API 400 - corpo risposta:", detail);
                if (detail && (detail.indexOf('Upgrade to Ultra') !== -1 || detail.indexOf('reached the limit') !== -1 || detail.indexOf('Cloud Agents simultaneously') !== -1)) {
                    return "Error: Limite Cloud Agents raggiunto per il tuo piano Cursor. Passa a Ultra per eseguire più agenti contemporaneamente. (400)";
                }
                return "Error: 400 Bad Request - Cursor API ha rifiutato la richiesta. Controlla: repo GitHub valido e accessibile, branch (ai_cursor_agent_ref), non usare model 'auto'. Dettaglio: " + (detail || err.message);
            }
            if (preview && (
                preview.indexOf("Failed to verify existence of branch") !== -1 ||
                preview.indexOf("branch 'main'") !== -1
            )) {
                return "Error: Repo/branch non valido per Cursor Cloud Agents. Il repo GitHub sembra vuoto o senza branch di default. Crea almeno 1 commit (README) su GitHub e riprova.";
            }
            return "Error: " + (preview ? preview : err.message);
        }
    }
    // TipoIA 3 = DeepSeek API
    if (config.TipoIA === 3) {
        try {
            console.log("Calling AI (DeepSeek)...");
            return await callAI_deepseek(prompt, content, options);
        } catch (err) {
            console.error("AI DeepSeek failed:", err.message);
            var status = err.response && err.response.status;
            var preview = getErrorPreview(err);
            if (err.code === 'ECONNRESET' || (err.code === 'ECONNABORTED') || (err.message && (err.message.indexOf('ECONNRESET') !== -1 || err.message.indexOf('socket hang up') !== -1))) {
                return "Error: Connessione DeepSeek interrotta (rete/timeout). Riprova.";
            }
            if (err.code === 'ECONNREFUSED' || (err.message && err.message.indexOf('Network') !== -1)) {
                return "Error: Impossibile raggiungere DeepSeek API. Controlla connessione e ai_deepseek_url.";
            }
            if (status === 401) {
                return "Error: 401 - Chiave DeepSeek non valida. Controlla ai_deepseek_key (https://platform.deepseek.com).";
            }
            if (status === 402) {
                return "Error: 402 - Crediti DeepSeek esauriti (Insufficient Balance). Ricarica il saldo su https://platform.deepseek.com.";
            }
            if (status === 400) {
                var data = err.response && err.response.data;
                console.error("[VISION] DeepSeek API 400 - Status:", status);
                console.error("[VISION] DeepSeek API 400 - Dettaglio:", data ? JSON.stringify(data, null, 2) : err.message);
                var msg = (data && (data.error && data.error.message)) ? data.error.message : (data && data.message) ? data.message : (preview || err.message);
                return "Error: 400 Bad Request - DeepSeek: " + msg;
            }
            return "Error: " + (preview ? preview : err.message);
        }
    }
    // TipoIA 2 = GPT4All (locale o in rete)
    if (config.TipoIA === 2) {
    const chatUrl = config.ai_api_url;
    const completionUrl = chatUrl.replace('/chat/completions', '/completions');
    const chatSystem = "";
    const chatUser = buildUserOnlyAiPayload(prompt, content);
    const chatBody = {
            model: config.ai_model,
            messages: [
            { role: "system", content: chatSystem },
            { role: "user", content: chatUser }
            ],
            stream: false
    };
    const completionBody = {
        model: config.ai_model,
        prompt: "User: " + chatUser + "\nAssistant:",
        max_tokens: 700,
        temperature: 0.2
    };
    const maxRetries = (config.ai_max_retries !== undefined && config.ai_max_retries > 0) ? config.ai_max_retries : 5;
    const baseDelay = config.ai_retry_delay_ms || 8000;

    var lastError;
    var lastPreview = '';

    function tryChat(useDummyAuth) {
        return doAIRequest(chatUrl, buildHeaders(useDummyAuth), chatBody).then(extractAIText);
    }
    function tryCompletions(useDummyAuth) {
        return doAIRequest(completionUrl, buildHeaders(useDummyAuth), completionBody).then(extractAIText);
    }

    for (var attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log("Calling AI (" + config.ai_model + ") tentativo " + attempt + "/" + maxRetries + " (timeout " + (timeoutMs / 1000) + "s)...");
            return await tryChat(false);
        } catch (err) {
            lastError = err;
            lastPreview = getErrorPreview(err);
            var status = err.response && err.response.status;
            if (status !== 401 || !config.ai_retry_on_401) break;
            var delay = baseDelay * attempt;
            console.log("401 ricevuto. Attesa " + (delay / 1000) + "s prima del prossimo tentativo (" + (attempt + 1) + "/" + maxRetries + ")...");
            await sleep(delay);
        }
    }

    if (lastError && lastError.response && lastError.response.status === 401) {
        console.log("Fallback: provo endpoint /completions...");
        try {
            return await tryCompletions(true);
        } catch (fallbackErr) {
            var fb = getErrorPreview(fallbackErr);
            return "Error: 401 Unauthorized dopo " + maxRetries + " tentativi. GPT4All response: " + (fb || lastPreview || "n/d");
        }
    }

    console.error("AI Call failed:", lastError ? lastError.message : "unknown");
    if (lastError && lastError.code === 'ECONNREFUSED') {
        return "Error: AI non raggiungibile. GPT4All è avviato? (porta 4891)";
    }
    if (lastError && lastError.response && lastError.response.status === 401) {
        return "Error: 401 Unauthorized. GPT4All response: " + (lastPreview || "n/d");
    }
    return "Error: " + (lastError ? lastError.message : "unknown");
    }
    return "Error: TipoIA non valido. Imposta TipoIA: 1 (Cursor), 2 (GPT4All) o 3 (DeepSeek) in config.js.";
};

// Normalizza una data articolo in formato YYYY-MM-DD (se possibile)
// Supporta:
// - formati standard parseabili da new Date(...)
// - stringhe relative tipo "9 ore fa", "6 ore fa", "30 minuti fa"
// - stringhe italiane tipo "Pubblicato 9 ore fa il 10 Marzo 2026"
//   o "10 Marzo 2026"
function normalizeArticleDateString(dateStr) {
    if (!dateStr) return null;
    var s = String(dateStr).trim();
    if (!s) return null;

    // Caso 1: stringhe relative "X ore fa" / "X minuti fa"
    // Esempi: "9 ore fa", "6 ore fa", "30 minuti fa", "15 min fa"
    var relMatch = s.match(/(\d+)\s*(ore|ora|h|ore fa|ora fa|minuti|minuto|min\.?)\s*fa?/i);
    if (relMatch) {
        var amount = parseInt(relMatch[1], 10);
        if (!isNaN(amount) && amount >= 0) {
            var now = new Date();
            var ms = now.getTime();
            var unit = relMatch[2].toLowerCase();
            if (unit.indexOf('min') === 0) {
                ms -= amount * 60 * 1000;
            } else {
                ms -= amount * 60 * 60 * 1000;
            }
            var dRel = new Date(ms);
            if (!isNaN(dRel.getTime())) {
                var yRel = dRel.getFullYear();
                var mRel = dRel.getMonth() + 1;
                var dayRel = dRel.getDate();
                var mmRel = mRel < 10 ? '0' + mRel : '' + mRel;
                var ddRel = dayRel < 10 ? '0' + dayRel : '' + dayRel;
                return yRel + '-' + mmRel + '-' + ddRel;
            }
        }
    }

    // Caso 2: formato numerico europeo "DD/MM/YYYY" o "DD-MM-YYYY"
    // Forza interpretazione giorno/mese in stile europeo per evitare ambiguità.
    var euMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (euMatch) {
        var dEu = parseInt(euMatch[1], 10);
        var mEu = parseInt(euMatch[2], 10);
        var yEu = parseInt(euMatch[3], 10);
        if (dEu >= 1 && dEu <= 31 && mEu >= 1 && mEu <= 12) {
            var mmEu = mEu < 10 ? '0' + mEu : '' + mEu;
            var ddEu = dEu < 10 ? '0' + dEu : '' + dEu;
            return yEu + '-' + mmEu + '-' + ddEu;
        }
    }

    // Caso speciale: pattern italiano "il 10 Marzo 2026" o "Pubblicato 9 ore fa il 10 Marzo 2026"
    // Estrai la parte "10 Marzo 2026"
    var itMatch = s.match(/(?:il\s+)?(\d{1,2})\s+([A-Za-zÀ-ÖØ-öø-ÿ]+)\s+(\d{4})/i);
    if (itMatch) {
        var dayStr = itMatch[1];
        var monthName = itMatch[2].toLowerCase();
        var yearStr = itMatch[3];
        var mesi = {
            'gennaio': 1,
            'febbraio': 2,
            'marzo': 3,
            'aprile': 4,
            'maggio': 5,
            'giugno': 6,
            'luglio': 7,
            'agosto': 8,
            'settembre': 9,
            'ottobre': 10,
            'novembre': 11,
            'dicembre': 12
        };
        var mIt = mesi[monthName];
        var dIt = parseInt(dayStr, 10);
        var yIt = parseInt(yearStr, 10);
        if (mIt && dIt && yIt) {
            var mmIt = mIt < 10 ? '0' + mIt : '' + mIt;
            var ddIt = dIt < 10 ? '0' + dIt : '' + dIt;
            return yIt + '-' + mmIt + '-' + ddIt;
        }
    }

    // Fallback: prova con Date standard (per formati tipo "2026-03-10", "2026/03/10", ecc.)
    var d = new Date(s);
    if (isNaN(d.getTime())) return null;
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    var mm = m < 10 ? '0' + m : '' + m;
    var dd = day < 10 ? '0' + day : '' + day;
    return y + '-' + mm + '-' + dd;
}

// Prova a estrarre una data articolo in formato testuale italiano dall'HTML completo della pagina.
// Esempi supportati (Renovatio21):
// "Pubblicato 9 ore fa il 10 Marzo 2026"
// "Pubblicato il 10 Marzo 2026"
// "10 Marzo 2026"
function extractArticleDateFromHtml(html) {
    if (!html || typeof html !== 'string') return null;
    try {
        // Rimuovi tag per lavorare su testo "piatto"
        var text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/\s+/g, ' ')
                       .trim();
        if (!text) return null;
        // Cerca prima pattern "Pubblicato ... il 10 Marzo 2026"
        var m = text.match(/Pubblicato[^\.]*?\bil\s+(\d{1,2}\s+[A-Za-zÀ-ÖØ-öø-ÿ]+\s+\d{4})/i);
        if (!m) {
            // Fallback: qualsiasi "10 Marzo 2026"
            m = text.match(/(\d{1,2}\s+[A-Za-zÀ-ÖØ-öø-ÿ]+\s+\d{4})/i);
        }
        if (m && m[1]) {
            return m[1].trim();
        }
    } catch (_) {}
    return null;
}

// Normalizza URL articolo in chiave univoca (per deduplicare articles.json)
function normalizeArticleUrlKey(urlLike) {
    if (!urlLike) return '';
    try {
        var u = new URL(String(urlLike), 'http://dummy.local');
        u.hash = '';
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

function normalizeAndSortArticlesByDate(articles) {
    if (!Array.isArray(articles)) return [];
    var mapped = articles.map(function (a) {
        var art = a && typeof a === 'object' ? Object.assign({}, a) : {};
        var rawDate = art.date || art.data || art.article_date || null;
        var norm = normalizeArticleDateString(rawDate);
        if (norm) {
            art.date = norm;
        }
        return art;
    });
    // Deduplica per URL normalizzato (mantiene il primo in ordine di arrivo)
    var seen = {};
    var out = [];
    for (var i = 0; i < mapped.length; i++) {
        var art = mapped[i] || {};
        var urlKey = normalizeArticleUrlKey(art.url || art.link || art.article_url || '');
        if (urlKey) {
            if (seen[urlKey]) continue;
            seen[urlKey] = true;
        }
        out.push(art);
    }
    out.sort(function (a, b) {
        var ad = normalizeArticleDateString(a.date || a.data || a.article_date) || '0000-01-01';
        var bd = normalizeArticleDateString(b.date || b.data || b.article_date) || '0000-01-01';
        if (ad < bd) return -1;
        if (ad > bd) return 1;
        return 0;
    });
    return out;
}

// API: Save Articles (from frontend). Body: array di articoli oppure { articles: [...], replace: true }.
// replace: true = sovrascrive articles.json con la lista (solo pertinenti dopo Fase 1B), normalizzando e ordinando per data crescente.
app.post('/api/save-articles', (req, res) => {
    const body = req.body;
    let articles = null;
    let replace = false;
    if (Array.isArray(body) && body.length > 0) {
        articles = body;
    } else if (body && typeof body === 'object' && Array.isArray(body.articles)) {
        articles = body.articles;
        replace = body.replace === true;
    }
    if (!Array.isArray(articles)) {
        return res.json({ success: false });
    }
    if (replace) {
        console.log('[VISION] Sostituzione articles.json con ' + articles.length + ' articoli (solo pertinenti).');
        var normalized = normalizeAndSortArticlesByDate(articles);
        writeJson(ARTICLES_FILE, normalized);
        return res.json({ success: true, count: normalized.length, replace: true });
    }
    if (articles.length === 0) {
        return res.json({ success: false });
    }
    console.log('Received ' + articles.length + ' articles from frontend (append).');
        let current = readJson(ARTICLES_FILE);
    if (!Array.isArray(current)) current = [];
        current = current.concat(articles);
    current = normalizeAndSortArticlesByDate(current);
        writeJson(ARTICLES_FILE, current);
        res.json({ success: true, count: current.length });
});

// API: Process
app.post('/api/process', async (req, res) => {
    GLOBAL_ELAB_ABORTED = false; // nuova elaborazione: resetta eventuale STOP precedente
    clearLogFile(); // azzera Log.txt ad ogni nuova elaborazione
    ensureElabReporterRunning('Fase 1 - scraping URL');
    elabStatus.processActive = (elabStatus.processActive || 0) + 1;
    markElabActivity();
    sendElabTelegramStatus('start').catch(function (_) {});
    abortCheck.setChecker(() => GLOBAL_ELAB_ABORTED);
    const body = req.body || {};
    const logQuestions = !!body.log_questions;
    var urls;
    if (body.urls && Array.isArray(body.urls) && body.urls.length > 0) {
        urls = body.urls.filter(u => u && u.url && u.active !== false);
        console.log(`Processing ${urls.length} URLs from request body (expanded list).`);
    } else {
    const allUrls = readJson(URLS_FILE);
        urls = allUrls.filter(u => u.active !== false);
    console.log(`Processing ${urls.length} active URLs out of ${allUrls.length} total.`);
    allUrls.forEach(u => {
        if (u.active === false) console.log(`[SKIP] Disabled URL: ${u.url}`);
    });
    }
    
    const results = [];
    
    // Reset all'avvio elaborazione: mantiene storico di articles/Accettati/Scartati/articolielaborati,
    // ma ripulisce gli output di sintesi della run corrente.
    // NAZIONI_ELABORATE_FILE (nazionielaborate.json) non più usato: non creare/azzerare
    writeJson(NAZIONI_ELABORATE_PESATO_FILE, {});
    writeJson(NAZIONI_ELABORATE_PESATO_SOMMATO_FILE, []);
    // sintesiVRED.json non azzerato qui: viene scritto da updateNazioniSintesiAlternativa (Genera VRed / chiamata finale)
    await writeTextSerialized(QUESTIONS_FILE, '');
    writeJson(LINK_SECONDARI_FILE, []);
    nazioniSintesi = { byCode: {}, byNation: {} };
    nazioniSintesiRawArray = [];
    console.log("Starting processing... Questions.json, link_secondari.json ripuliti (articles/Accettati/Scartati/articolielaborati mantenuti).");

    let processedCount = 0;
    elabStatus.processTotalUrls = urls.length;
    elabStatus.processProcessedUrls = 0;
    for (const item of urls) {
        if (GLOBAL_ELAB_ABORTED) {
            console.log('[Server] Elaborazione interrotta dall\'utente (scraping).');
            elabStatus.processActive = Math.max(0, (elabStatus.processActive || 0) - 1);
            setElabPhase('Interrotta durante scraping');
            sendElabTelegramStatus('aborted').catch(function (_) {});
            return res.json({ timestamp: new Date().toISOString(), details: results, aborted: true });
        }
        processedCount++;
        elabStatus.processProcessedUrls = processedCount;
        const url = item.url;
        const type = item.type || 'blog';
        elabStatus.lastUrl = String(url || '');
        elabStatus.lastUrlType = String(type || '');
        markElabActivity();
        
        console.log(`[Server] Processing URL ${processedCount}/${urls.length}: ${url} (${type})`);
        
        if (!url) continue;

        try {
            if (type === 'telegram') {
                try {
                    var promptScrapingTelegram = (config.prompts && config.prompts.scraping_Telegram) || '';
                    if (!promptScrapingTelegram.trim()) {
                        promptScrapingTelegram = 'Estrai i post dal canale Telegram indicato. Rispondi SOLO con un array JSON di oggetti con campi: "testo", "Data", "linkvideo".';
                    }
                    var pageRespTg = await axios.get(url, {
                        timeout: 20000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
                            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
                        }
                    });
                    var htmlRawTg = String(pageRespTg && pageRespTg.data ? pageRespTg.data : '');
                    var cleanTelegramText = '';
                    try {
                        var cheerio = require('cheerio');
                        var $tg = cheerio.load(htmlRawTg);
                        $tg('script,style,noscript,svg,path').remove();
                        var postTexts = [];
                        $tg('.tgme_widget_message_text').each(function () {
                            var el = $tg(this);
                            var t = el.text().replace(/\s+/g, ' ').trim();
                            if (!t) return;
                            var wrap = el.closest('.tgme_widget_message_wrap');
                            var dt = '';
                            if (wrap && wrap.length) {
                                dt = String(
                                    wrap.find('.tgme_widget_message_date time').first().attr('datetime') ||
                                    wrap.find('time[datetime]').first().attr('datetime') ||
                                    wrap.find('.tgme_widget_message_date').first().text() ||
                                    ''
                                ).trim();
                            }
                            if (dt) postTexts.push('datetime: ' + dt + '\n' + t);
                            else postTexts.push(t);
                        });
                        if (postTexts.length > 0) {
                            // Mantieni solo i primi 50 post trovati per contenere il payload.
                            cleanTelegramText = postTexts.slice(0, 50).join('\n--- FINE POST---\n');
                        } else {
                            cleanTelegramText = $tg('body').text().replace(/\s+/g, ' ').trim();
                        }
                    } catch (eClean) {
                        cleanTelegramText = extractArticleText(htmlRawTg, url);
                    }
                    // Input troppo lungo aumenta il rischio di output JSON troncato.
                    if (cleanTelegramText.length > 45000) {
                        cleanTelegramText = cleanTelegramText.substring(0, 45000) + '\n...[testo troncato]';
                    }
                    var sentScrape = 'Input: testo Telegram già estratto da HTML e ripulito (con eventuali righe "datetime: ..."). Spezza in singoli post e restituisci SOLO JSON nel formato richiesto (massimo 20 post).\n\n' + cleanTelegramText;
                    console.log('[VISION] scraping_telegram (tentativo 1) -> System prompt:');
                    console.log('--- inizio system ---');
                    console.log(promptScrapingTelegram.trim());
                    console.log('--- fine system ---');
                    console.log('[VISION] scraping_telegram (tentativo 1) -> User content:');
                    console.log('--- inizio user ---');
                    console.log(sentScrape);
                    console.log('--- fine user ---');
                    var tgMax = (typeof config.ai_deepseek_max_tokens_scraping_telegram === 'number' && config.ai_deepseek_max_tokens_scraping_telegram > 0) ? config.ai_deepseek_max_tokens_scraping_telegram : 2800;
                    var raw = await callAI(promptScrapingTelegram.trim(), sentScrape, { max_tokens: tgMax });
                    var rawStr = (typeof raw === 'string' ? raw : String(raw || '')).trim();
                    console.log('[VISION] scraping_telegram -> Risposta IA (grezza):');
                    console.log('--- inizio risposta IA grezza ---');
                    console.log(rawStr);
                    console.log('--- fine risposta IA grezza ---');
                    recordQuestion('scraping_telegram', sentScrape, rawStr, { url: url, attempt: 1, system: promptScrapingTelegram.trim() });
                    var posts = parseTelegramPostsFromAiResponse(rawStr);
                    if (!posts.length) {
                        var sentScrapeRetry = 'Input: testo Telegram già estratto da HTML e ripulito (con eventuali righe "datetime: ..."). Estrai SOLO i primi 12 post. Rispondi esclusivamente con array JSON valido, senza testo extra.\n\n' + cleanTelegramText;
                        console.log('[VISION] scraping_telegram (retry anti-troncamento) -> User content:');
                        console.log('--- inizio user ---');
                        console.log(sentScrapeRetry);
                        console.log('--- fine user ---');
                        var tgRetryMax = (typeof config.ai_deepseek_max_tokens_scraping_telegram_retry === 'number' && config.ai_deepseek_max_tokens_scraping_telegram_retry > 0) ? config.ai_deepseek_max_tokens_scraping_telegram_retry : 2200;
                        var rawRetry = await callAI(promptScrapingTelegram.trim(), sentScrapeRetry, { max_tokens: tgRetryMax });
                        var rawRetryStr = (typeof rawRetry === 'string' ? rawRetry : String(rawRetry || '')).trim();
                        console.log('[VISION] scraping_telegram (retry anti-troncamento) -> Risposta IA (grezza):');
                        console.log('--- inizio risposta IA grezza ---');
                        console.log(rawRetryStr);
                        console.log('--- fine risposta IA grezza ---');
                        recordQuestion('scraping_telegram', sentScrapeRetry, rawRetryStr, { url: url, attempt: 2, retry: 'anti_troncamento_20_posts', system: promptScrapingTelegram.trim() });
                        posts = parseTelegramPostsFromAiResponse(rawRetryStr);
                    }
                    if (posts.length > 0) {
                        console.log('[Telegram/IA] Post ricavati: ' + posts.length);
                        var outItem = {
                            type: 'telegram_posts',
                            original_type: 'telegram_ai',
                            url: url,
                            tg_posts: posts
                        };
                        if (logQuestions) {
                            outItem.tg_prompt_preview = sentScrape.substring(0, 2000);
                        }
                        results.push(outItem);
                    } else {
                        results.push({ url, error: 'Nessun post Telegram parsabile dalla risposta IA' });
                    }
                } catch (e) {
                    console.error('Telegram/IA error:', e.message);
                    results.push({ url, error: e.message });
                }
                continue;
            }
            if (type === 'youtube') {
                try {
                    var youtubeUrl = url;
                    try {
                        var yu = new URL(String(url || ''));
                        var host = (yu.hostname || '').toLowerCase();
                        var path = yu.pathname || '/';
                        var isWatchLike = /^\/(watch|shorts|live|embed)\b/.test(path);
                        var isSearchResults = /^\/results\/?(\/|$)/.test(path);
                        // Riscrivi solo pagine canale (es. /@user) in .../videos; non toccare /results?search_query=...
                        if (host.indexOf('youtube.com') !== -1 && !isWatchLike && !isSearchResults && !/\/videos\/?$/.test(path)) {
                            yu.pathname = path.replace(/\/+$/, '') + '/videos';
                            yu.search = '';
                            youtubeUrl = yu.toString();
                        }
                    } catch (_) {}

                    var pageRespYt = await axios.get(youtubeUrl, {
                        timeout: 20000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
                            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
                        }
                    });
                    var htmlRawYt = String(pageRespYt && pageRespYt.data ? pageRespYt.data : '');
                    var ytLinks = extractYoutubeLinksFromHtml(htmlRawYt, youtubeUrl);

                    if (ytLinks.length > 0) {
                        console.log('[YouTube/HTML] Link video ricavati: ' + ytLinks.length);
                        var outYt = {
                            type: 'youtube_links',
                            original_type: 'youtube_html',
                            url: youtubeUrl,
                            yt_links: ytLinks
                        };
                        if (logQuestions) outYt.yt_prompt_preview = ('Scraping HTML YouTube da: ' + youtubeUrl + '\nSelector: div#contents (ytd-rich-grid-renderer + ytd-section-list-renderer)');
                        results.push(outYt);
                    } else {
                        results.push({ url: youtubeUrl, error: 'Nessun link YouTube trovato nella sezione #contents' });
                    }
                } catch (e) {
                    console.error('YouTube/HTML error:', e.message);
                    results.push({ url, error: e.message || 'Errore scraping YouTube/HTML' });
                }
                continue;
            }

            const scraper = ScraperFactory.getScraper(url, type);
            if (!scraper) {
                console.log(`No scraper found for ${url}`);
                continue;
            }

            const data = await scraper.scrape();
            
            if (data) {
                if (data.type === 'raw_html') {
                    console.log(`Returning raw HTML for ${url} to frontend.`);
                    results.push({ ...data, type: 'raw_html' });
                } else if (data.type === 'raw_xml') {
                    console.log(`Returning raw XML (RSS) for ${url} to frontend.`);
                    results.push({ ...data, type: 'raw_xml' });
                } else {
                    results.push(data);
                }
            } 

        } catch (error) {
            if (error.message === 'Elaborazione annullata dall\'utente.') {
                console.log('[Server] Scraping interrotto dall\'utente.');
                return res.json({ timestamp: new Date().toISOString(), details: results, aborted: true });
            }
            console.error(`Error processing ${url}:`, error.message);
            results.push({ url, error: error.message });
        }
    }

    // Return the results (which contain HTMLs) to the frontend
    // Frontend will process them and call /api/save-articles
    res.json({ 
        timestamp: new Date().toISOString(),
        details: results 
    });
    elabStatus.processActive = Math.max(0, (elabStatus.processActive || 0) - 1);
    setElabPhase('Fase 1 completata - attesa analisi articoli');
    markElabActivity();
});

async function resetAllJsonInActiveFolder() {
    clearLogFile(); // azzera Log.txt con CLEAR
    // Dati di run
    writeJson(RESULTS_FILE, []);
    writeJson(ARTICLES_FILE, []);
    writeJson(ARTICOLI_ELABORATI_FILE, []);
    writeJson(LINK_SECONDARI_FILE, []);
    await writeTextSerialized(QUESTIONS_FILE, '');
    writeJson(SCARTATI_FILE, []);
    writeJson(ACCETTATI_FILE, []);
    writeJson(ERRORI_FILE, []);

    // Output sintesi e file derivati
    await writeJsonSerialized(SINTESI_NAZIONI_FILE, []);
    await writeJsonSerialized(SINTESI_ALTERNATIVA_FILE, []);
    writeJson(NAZIONI_ELABORATE_FILE, []);
    // Non cancellare EMWA_Pesato e EMWA_Pesato_Sommato: restano fino a rigenerazione.
    // Articoli_riassunto invece viene azzerato con CLEAR per coerenza UI.
    // writeJson(NAZIONI_ELABORATE_PESATO_FILE, {});
    // writeJson(NAZIONI_ELABORATE_PESATO_SOMMATO_FILE, {});
    writeJson(ARTICOLI_RIASSUNTO_FILE, []);
    // Reset deprecated files
    writeJson(NAZIONI_EWMA_FILE, []);
    writeJson(NAZIONI_EMWA_IA_FILE, []);
    await writeJsonSerialized(SINTESI_EMWA_FILE, []);
    await writeJsonSerialized(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_FILE, []);
    await writeJsonSerialized(SINTESI_NAZIONI_ELAB_PESATO_SOMMATO_IA_FILE, []);
    // Articoli_riassunto.json non cancellato qui (si rigenera con buildAndWriteArticoliRiassunto)
    await writeJsonSerialized(SINTESI_V4_FILE, []);
    await writeJsonSerialized(SINTESI_V5_FILE, []);
    await writeJsonSerialized(SINTESI_NAZIONI_ELAB_IA_FILE, []);
    
    await writeJsonSerialized(SINTESI_VRED_FILE, []);
    await writeJsonSerialized(NOTE_FILE, { byNation: {}, byCode: {} });

    nazioniSintesi = { byCode: {}, byNation: {} };
    nazioniSintesiRawArray = [];
}

app.post('/api/clear-json', async (req, res) => {
    try {
        await resetAllJsonInActiveFolder();
        console.log('[VISION] CLEAR: reset completato per tutti i file JSON della cartella attiva: ' + JSON_DIR);
        res.json({ success: true, message: 'JSON folder reset completed', json_dir: JSON_DIR });
    } catch (e) {
        console.error('clear-json error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

function extractYoutubeVideoId(urlStr) {
    try {
        var u = new URL(String(urlStr || ''));
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

function extractYoutubeLinksFromHtml(htmlRaw, pageUrl) {
    if (!htmlRaw) return [];
    try {
        var cheerio = require('cheerio');
        var $ = cheerio.load(String(htmlRaw || ''));
        var out = [];
        var seen = {};

        function pushLink(href, titleRaw) {
            if (!href) return;
            var abs = '';
            try {
                abs = new URL(String(href), pageUrl).href;
            } catch (_) {
                return;
            }
            var vid = extractYoutubeVideoId(abs);
            if (!vid || seen[vid]) return;
            seen[vid] = true;
            var title = String(titleRaw || '').replace(/\s+/g, ' ').trim();
            out.push({
                linkvideo: 'https://www.youtube.com/watch?v=' + vid,
                video_id: vid,
                title: title
            });
        }

        // Griglia principale (home / tab Video canale).
        $('div#contents.style-scope.ytd-rich-grid-renderer a[href]').each(function () {
            var el = $(this);
            pushLink(el.attr('href'), el.attr('title') || el.attr('aria-label') || el.text());
        });

        // Sezione lista (es. altre sezioni della pagina canale).
        $('div#contents.style-scope.ytd-section-list-renderer a[href]').each(function () {
            var el = $(this);
            pushLink(el.attr('href'), el.attr('title') || el.attr('aria-label') || el.text());
        });

        // Pagina risultati ricerca (ytd-video-renderer = singolo risultato video).
        $('ytd-video-renderer a[href*="/watch"], ytd-video-renderer a[href*="youtube.com/watch"]').each(function () {
            var el = $(this);
            pushLink(el.attr('href'), el.attr('title') || el.attr('aria-label') || el.text());
        });

        // Fallback se YouTube cambia classi/minimizza la pagina.
        if (!out.length) {
            $('div#contents a[href], a[href]').each(function () {
                var el = $(this);
                pushLink(el.attr('href'), el.attr('title') || el.attr('aria-label') || el.text());
            });
        }

        // Fallback JSON inline.
        if (!out.length) {
            var re = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
            var m;
            while ((m = re.exec(String(htmlRaw))) !== null) {
                var vid = m[1];
                if (!vid || seen[vid]) continue;
                seen[vid] = true;
                out.push({
                    linkvideo: 'https://www.youtube.com/watch?v=' + vid,
                    video_id: vid,
                    title: ''
                });
            }
        }
        return out;
    } catch (_) {
        return [];
    }
}

async function getYoutubeUploadDate(videoId) {
    try {
        var watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
        var resp = await axios.get(watchUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        var html = String(resp.data || '');
        // Cerca uploadDate nel microformat (formato ISO 8601 YYYY-MM-DD)
        var m = html.match(/"uploadDate":"(\d{4}-\d{2}-\d{2})/);
        if (m && m[1]) return m[1];
        return null;
    } catch (e) {
        console.error('[Youtube Date] Error fetching date:', e.message);
        return null;
    }
}

async function getYoutubeCaptionsTranscript(videoId) {
    var watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
    var resp = await axios.get(watchUrl, {
        timeout: 20000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
        }
    });
    var html = String(resp.data || '');
    var m = html.match(/"captionTracks":(\[[\s\S]*?\])/);
    if (!m || !m[1]) return null;
    var tracks = null;
    try { tracks = JSON.parse(m[1]); } catch (e) { return null; }
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    var preferred = tracks.find(function (t) {
        var lc = t && t.languageCode ? String(t.languageCode).toLowerCase() : '';
        return lc.indexOf('it') === 0;
    }) || tracks[0];
    var baseUrl = preferred && preferred.baseUrl ? preferred.baseUrl : null;
    if (!baseUrl) return null;
    var capResp = await axios.get(baseUrl, {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    var xml = String(capResp.data || '');
    if (!xml.trim()) return null;
    var segments = [];
    var re = /<text[^>]*>([\s\S]*?)<\/text>/g;
    var mm;
    while ((mm = re.exec(xml)) !== null) {
        var txt = String(mm[1] || '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
        if (txt) segments.push(txt);
    }
    if (!segments.length) return null;
    return segments.join(' ').substring(0, 16000);
}

async function getYoutubeTranscriptFallbackYtDlp(videoUrl) {
    // Richiede yt-dlp installato nel sistema. Tenta di scaricare i sottotitoli (auto/ufficiali) e convertirli in testo.
    try {
        var pathMod = require('path');
        var fsMod = require('fs');
        var os = require('os');
        var candidates = [
            pathMod.join(__dirname, 'yt-dlp_macos'),
            pathMod.join(__dirname, 'yt-dlp'),
            'yt-dlp'
        ];
        var lastErr = null;
        async function runYtDlp(binPath, extraArgs) {
            // Aggiungi User-Agent per evitare rate-limit (429) di YouTube
            var finalArgs = [
                '--user-agent',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
                '--no-playlist',
                '--no-check-certificates',
                '--ignore-errors'
            ].concat(extraArgs);

            console.log('[YT-DLP] try:', binPath, finalArgs.join(' '));
            // Aumentato timeout a 120s e buffer a 50MB
            var out = await execFileAsync(binPath, finalArgs, { timeout: 120000, maxBuffer: 50 * 1024 * 1024 });
            return out;
        }

        // Tenta di trovare un binario funzionante
        var workingBin = null;
        for (var i = 0; i < candidates.length; i++) {
            var bin = candidates[i];
            // Se è un path locale (non 'yt-dlp' globale), verifica che esista
            if (bin !== 'yt-dlp') {
                try { 
                    if (!fsMod.existsSync(bin)) {
                        continue; 
                    }
                } catch (e) { 
                    continue; 
                }
            }
            workingBin = bin;
            break;
        }
        if (!workingBin) throw new Error('Nessun binario yt-dlp trovato');

        console.log('[YT-DLP] Using binary:', workingBin);

        // 1) Ottieni video id (opzionale, ma utile per debug)
        // var idOut = await runYtDlp(workingBin, ['--print', 'id', videoUrl]);
        
        var videoId = (String(videoUrl).match(/[?&]v=([a-zA-Z0-9_-]{6,})/) || [null, null])[1];
        if (!videoId) {
             // Fallback: prova a estrarre ID con yt-dlp se regex fallisce
             try {
                 var idOut = await runYtDlp(workingBin, ['--print', 'id', videoUrl]);
                 videoId = idOut && idOut.stdout ? String(idOut.stdout).trim().split(/\s+/).pop() : 'video';
             } catch(e) { videoId = 'video'; }
        }

        // 2) Scarica i sottotitoli in una directory temporanea
        var tmpDir = pathMod.join(os.tmpdir(), 'vision-ytdlp-subs');
        try { fsMod.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
        
        // Pulizia preventiva file vecchi per questo ID
        try {
            var oldFiles = fsMod.readdirSync(tmpDir);
            oldFiles.forEach(f => {
                if (f.startsWith(videoId)) fsMod.unlinkSync(pathMod.join(tmpDir, f));
            });
        } catch (_) {}

        var outputTemplate = pathMod.join(tmpDir, '%(id)s.%(ext)s');
        
        // Tenta il download dei sottotitoli
        await runYtDlp(workingBin, [
            '--skip-download',
            '--write-auto-subs',
            '--write-subs',
            '--sub-langs', 'it.*,it,en.*,en',
            '--sub-format', 'vtt',
            '-o', outputTemplate,
            videoUrl
        ]);
        
        // 3) Cerca i file .vtt scaricati
        var files = [];
        try { files = fsMod.readdirSync(tmpDir).filter(fn => fn.toLowerCase().endsWith('.vtt') && fn.indexOf(videoId) !== -1); } catch (_) {}
        if (!files || files.length === 0) {
            try { files = fsMod.readdirSync(tmpDir).filter(fn => fn.toLowerCase().endsWith('.vtt')); } catch (_) {}
        }
        if (!files || files.length === 0) return null;
        function pickFile(arr) {
            var it = arr.find(f => /\.it\./i.test(f) || /lang=it/i.test(f));
            if (it) return it;
            var en = arr.find(f => /\.en\./i.test(f) || /lang=en/i.test(f));
            if (en) return en;
            return arr[0];
        }
        var chosen = pickFile(files);
        var full = pathMod.join(tmpDir, chosen);
        var vtt = '';
        try { vtt = fsMod.readFileSync(full, 'utf8'); } catch (_) { vtt = ''; }
        if (!vtt) return null;
        var lines = vtt.split(/\r?\n/);
        var textLines = [];
        for (var li = 0; li < lines.length; li++) {
            var L = lines[li].trim();
            if (!L) continue;
            if (L === 'WEBVTT') continue;
            if (L.startsWith('Kind:') || L.startsWith('Language:') || L.startsWith('Style:')) continue;
            if (/^\d+$/.test(L)) continue;
            if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(L)) continue;
            L = L.replace(/<[^>]+>/g, '').trim();
            // Evita duplicati consecutivi (comune nei sottotitoli automatici)
            if (L && (textLines.length === 0 || textLines[textLines.length - 1] !== L)) {
                textLines.push(L);
            }
        }
        var plain = textLines.join(' ').replace(/\s+/g, ' ').trim();
        return plain ? plain.substring(0, 16000) : null;
    } catch (e) {
        console.error('[YT-DLP Error]', e.message);
        if (e.stderr) console.error('[YT-DLP stderr]', String(e.stderr).trim());
        if (e.stdout) console.error('[YT-DLP stdout]', String(e.stdout).trim());
    }
    return null;
}

// API: YouTube transcript. Prima prova caption ufficiali, poi fallback yt-dlp.
app.post('/api/youtube-transcript', async (req, res) => {
    var body = req.body || {};
    var url = body.url || '';
    var videoId = body.video_id || extractYoutubeVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, error: 'video_id non valido' });

    // --- VERIFICA DATA ---
    try {
        var settings = normalizeFolderSettings(readJsonObject(FOLDER_SETTINGS_FILE, null));
        var hours = settings.validity_hours || 48;
        
        var uploadDateStr = await getYoutubeUploadDate(videoId);
        if (uploadDateStr) {
            var uploadMs = Date.parse(uploadDateStr);
            var nowMs = Date.now();
            // Calcola differenza in ore. Aggiungiamo 24h di tolleranza per fusi orari/data senza orario.
            var diffHours = (nowMs - uploadMs) / (1000 * 60 * 60);
            if (diffHours > (hours + 24)) {
                console.log(`[YouTube] Video ${videoId} scartato per data: ${uploadDateStr} (limite ${hours}h + 24h tolleranza)`);
                return res.json({ success: false, error: 'Video troppo vecchio: ' + uploadDateStr + ' (limite: ' + hours + 'h)' });
            }
        }
    } catch (e) {
        console.warn('[YouTube] Verifica data fallita:', e.message);
    }
    // ---------------------

    var canonical = 'https://www.youtube.com/watch?v=' + videoId;
    try {
        var cap = await getYoutubeCaptionsTranscript(videoId);
        if (cap && cap.trim().length > 0) {
            return res.json({ success: true, source: 'captions', transcript: cap.trim().substring(0, 16000), video_id: videoId, url: canonical });
        }
        var fb = await getYoutubeTranscriptFallbackYtDlp(canonical);
        if (fb && fb.trim().length > 0) {
            return res.json({ success: true, source: 'yt-dlp', transcript: fb.trim().substring(0, 16000), video_id: videoId, url: canonical });
        }
        return res.json({ success: false, error: 'Trascrizione non disponibile (no captions / no fallback)' });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message || 'Errore trascrizione YouTube' });
    }
});

// API: Fetch Article Content
app.post('/api/fetch-article', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    console.log(`Fetching article content for: ${url}`);
    try {
        const { data } = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 15000
        });
        
        console.log(`Article downloaded. Length: ${data.length} chars.`);
        res.json({ url, html: data, length: data.length });
    } catch (error) {
        console.error(`Error fetching article ${url}:`, error.message);
        res.json({ url, error: error.message });
    }
});

// Estrae solo il testo dell'articolo: contenuto principale e taglio a "fine articolo" (commenti, correlati, footer, ecc.)
// Per pagine Telegram (Chat): usa solo il singolo post. Se pageUrl è tipo t.me/s/channel/82354, prende il messaggio con quel post ID; altrimenti il primo.
function extractArticleText(html, pageUrl) {
    var cheerio = require('cheerio');
    var $ = cheerio.load(html);
    $('script').remove();
    $('style').remove();
    $('noscript').remove();
    $('nav').remove();
    $('footer').remove();
    $('header').remove();
    $('aside').remove();
    $('iframe').remove();

    var container = null;
    var tgWraps = $('.tgme_widget_message_wrap');
    if (tgWraps.length > 0) {
        var postIdMatch = typeof pageUrl === 'string' && pageUrl.match(/\/(\d+)\s*$/);
        var wantedPostId = postIdMatch ? postIdMatch[1] : null;
        var chosenWrap = null;
        if (wantedPostId) {
            tgWraps.each(function () {
                var wrap = $(this);
                var link = wrap.find('.tgme_widget_message_date a').attr('href') || wrap.find('a[href*="' + wantedPostId + '"]').attr('href') || '';
                if (link.indexOf(wantedPostId) !== -1) {
                    chosenWrap = wrap;
                    return false;
                }
            });
        }
        if (!chosenWrap || !chosenWrap.length) chosenWrap = tgWraps.first();
        var textEl = chosenWrap.find('.tgme_widget_message_text');
        container = textEl.length ? textEl : chosenWrap;
        var singlePostText = container.text().replace(/\s+/g, ' ').trim();
        return singlePostText.substring(0, 8000);
    }

    var mainSelectors = [
        'article',
        'main',
        '[role="main"]',
        '.entry-content',
        '.post-content',
        '.article-content',
        '.article-body',
        '.post-body',
        '.content-body',
        '.single-content',
        '.post-entry',
        '.entry-body',
        '#article-body',
        '#content .post',
        '.hentry .entry-content',
        '.content',
        '#content'
    ];
    for (var i = 0; i < mainSelectors.length; i++) {
        var el = $(mainSelectors[i]).first();
        if (el.length) {
            var txt = el.text().replace(/\s+/g, ' ').trim();
            if (txt.length > 200) {
                container = el;
                break;
            }
        }
    }
    if (!container || !container.length) container = $('body');

    var clone = container.clone();
    var stopSelectors = [
        '#comments', '.comments', '.commenti', '.comment-form', '#respond', '.respond',
        '.related-posts', '.articoli-correlati', '.related', '.post-related', '.more-posts', '.altri-articoli',
        '.share', '.social-share', '.condividi', '.share-buttons', '.sharing',
        '.newsletter', '.subscribe', '.iscriviti',
        '.author-bio', '.post-author', '.article-author',
        '.entry-footer', '.post-footer', '.article-footer', '.content-footer',
        '.tags', '.post-tags', '.article-tags',
        '.breadcrumb', '.advertisement', '.ads', '[id*="comment"]', '[class*="comment"]'
    ];
    stopSelectors.forEach(function (sel) {
        try { clone.find(sel).remove(); } catch (e) {}
    });

    var text = clone.text().replace(/\s+/g, ' ').trim();

    var endMarkers = [
        /\s+articoli correlati\s+/i, /\s+leggi anche\s+/i, /\s+potrebbe interessarti\s+/i,
        /\s+altri articoli\s+/i, /\s+related posts?\s+/i, /\s+read also\s+/i,
        /\s+lascia un commento\s+/i, /\s+leave a comment\s+/i,
        /\s+condividi questo articolo\s+/i, /\s+share this article\s+/i, /\s+condividi\s+stampa\s+/i,
        /\s+iscriviti alla newsletter\s+/i, /\s+subscribe to newsletter\s+/i,
        /\s+tag:\s*$/i, /\s+categoria:\s*$/i,
        /\s+previous article\s+/i, /\s+next article\s+/i,
        /\s+commenti\s*$/i, /\s+comments\s*$/i
    ];
    var minIndex = text.length;
    for (var j = 0; j < endMarkers.length; j++) {
        var match = text.match(endMarkers[j]);
        if (match && match.index !== undefined && match.index > 150) {
            if (match.index < minIndex) minIndex = match.index;
        }
    }
    if (minIndex < text.length) text = text.substring(0, minIndex).trim();

    return text.substring(0, 8000);
}

// Dalla risposta IA estrae solo il JSON delle nazioni (array di { nazione, ...params }). Ritorna null se assente o invalido.
function extractNationsJsonFromAiResponse(rawStr) {
    if (!rawStr || typeof rawStr !== 'string') return null;
    var s = rawStr.trim();
    function normalizeNationsArray(arr) {
        if (!Array.isArray(arr)) return null;
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var o = arr[i];
            if (!o || !o.nazione) continue;
            var clean = { nazione: String(o.nazione).trim() };
            for (var k in o) {
                if (k === 'nazione' || k === 'commento') continue;
                if (typeof o[k] === 'number') clean[k] = o[k];
            }
            out.push(clean);
        }
        return out.length > 0 ? out : null;
    }
    try {
        var jsonStr = null;
        var jsonBlock = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonBlock) jsonStr = jsonBlock[1].trim();
        if (!jsonStr) {
            var arrMatch = s.match(/\[\s*\{[\s\S]*\}\s*\]/);
            if (arrMatch) jsonStr = arrMatch[0];
            else {
                var objMatch = s.match(/\{[\s\S]*\}/);
                if (objMatch) jsonStr = objMatch[0];
            }
        }
        if (!jsonStr) return null;
        var data = JSON.parse(jsonStr);
        var arr = null;
        if (Array.isArray(data)) {
            arr = data;
        } else if (data && typeof data === 'object' && Array.isArray(data.nazioni)) {
            arr = data.nazioni;
        } else {
            return null;
        }
        return normalizeNationsArray(arr);
    } catch (e) {
        // fallback anti-troncamento sotto
    }

    // Fallback anti-troncamento: recupera oggetti JSON completi anche se l'array finale è spezzato.
    try {
        var src = (jsonStr && jsonStr.length > 0) ? jsonStr : s;
        var arrayStart = src.indexOf('[');
        if (arrayStart !== -1) src = src.substring(arrayStart);
        var objs = [];
        var start = -1, depth = 0, inStr = false, esc = false;
        for (var j = 0; j < src.length; j++) {
            var ch = src[j];
            if (inStr) {
                if (esc) { esc = false; continue; }
                if (ch === '\\') { esc = true; continue; }
                if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') { inStr = true; continue; }
            if (ch === '{') {
                if (depth === 0) start = j;
                depth++;
            } else if (ch === '}') {
                if (depth > 0) depth--;
                if (depth === 0 && start >= 0) {
                    objs.push(src.substring(start, j + 1));
                    start = -1;
                }
            }
        }
        var recovered = [];
        for (var k = 0; k < objs.length; k++) {
            try {
                var parsedObj = JSON.parse(objs[k]);
                if (parsedObj && parsedObj.nazione) recovered.push(parsedObj);
            } catch (_) {}
        }
        var outRecovered = normalizeNationsArray(recovered);
        if (outRecovered && outRecovered.length > 0) {
            console.log('[VISION] extractNationsJsonFromAiResponse: recuperate ' + outRecovered.length + ' nazioni da risposta troncata.');
            return outRecovered;
        }
    } catch (_) {}
    return null;
}

// Dalla risposta IA di question_per_article prova a estrarre l'autore dell'articolo (campo "autore" oppure "author").
function extractAuthorFromQuestionPerArticleResponse(rawStr) {
    if (!rawStr || typeof rawStr !== 'string') return null;
    var s = rawStr;
    var m = s.match(/"autore"\s*:\s*"([^"]{1,200})"/i);
    if (!m) m = s.match(/"author"\s*:\s*"([^"]{1,200})"/i);
    if (!m) m = s.match(/"autore_articolo"\s*:\s*"([^"]{1,200})"/i);
    if (!m) m = s.match(/"author_article"\s*:\s*"([^"]{1,200})"/i);
    if (m && m[1]) {
        var val = m[1].trim();
        if (val) return val;
    }
    return null;
}

// Dalla risposta IA (Fase 1B) estrae { pertinente: "PERTINENTE"|"NON PERTINENTE", nota: string, notizia?: string }
function parsePertinenteFromAiResponse(rawStr) {
    if (!rawStr || typeof rawStr !== 'string') return { pertinente: 'NON PERTINENTE', nota: 'Risposta vuota', notizia: '', author: null };
    var s = rawStr.trim();
    var nota = '';
    var notizia = '';
    var author = null;
    var pertinente = /NON\s*PERTINENTE/i.test(s) ? 'NON PERTINENTE' : 'PERTINENTE';
    var parsedJson = false;
    try {
        var jsonStr = null;
        var jsonBlock = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonBlock) jsonStr = jsonBlock[1].trim();
        if (!jsonStr) { var objMatch = s.match(/\{[\s\S]*\}/); if (objMatch) jsonStr = objMatch[0]; }
        if (jsonStr) {
            var data = JSON.parse(jsonStr);
            parsedJson = true;
            // Se l'IA restituisce un array, usa il primo elemento
            if (Array.isArray(data) && data.length > 0) {
                data = data[0];
            }
            if (data && typeof data === 'object') {
                var statoField = null;
                if (typeof data.pertinente === 'string') statoField = data.pertinente;
                else if (typeof data.stato === 'string') statoField = data.stato;
                if (statoField) {
                    pertinente = /NON\s*PERTINENTE/i.test(statoField) ? 'NON PERTINENTE' : 'PERTINENTE';
                }
                if (typeof data.nota === 'string') nota = data.nota.trim();
                if (typeof data.notizia === 'string') notizia = data.notizia.trim();
                else if (typeof data.news === 'string') notizia = data.news.trim();
                if (typeof data.autore === 'string') author = data.autore.trim();
                else if (typeof data.author === 'string') author = data.author.trim();
            }
        }
    } catch (e) {}
    // Se non siamo riusciti a estrarre una nota dal JSON, evita di mostrare il JSON grezzo.
    if (!nota) {
        // parsedJson == true oppure presenza evidente di strutture JSON: non rimettere l'intero JSON nelle note
        if (parsedJson || /[\{\[]/.test(s)) {
            // Nessuna nota esplicita: usa solo un riepilogo minimale.
            nota = pertinente === 'PERTINENTE' ? '' : 'NON PERTINENTE';
        } else if (s.length > 0) {
            // Vecchio formato: fallback al testo troncato.
            nota = s.length > 500 ? s.substring(0, 500) + '...' : s;
        }
    }
    return { pertinente: pertinente, nota: nota, notizia: notizia, author: author };
}

function isPertinenteAiErrorResponse(rawStr) {
    if (rawStr == null) return true;
    var s = String(rawStr).trim();
    if (!s) return true;
    if (/^error\s*:/i.test(s)) return true;
    if (/^\s*\{/.test(s) || /^\s*```/m.test(s)) return false;
    if (/PERTINENTE|NON\s*PERTINENTE/i.test(s)) return false;
    return true;
}

// Rimuove link (http, https, www, t.me, telegram.me) dal testo
function stripLinksFromText(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/https?:\/\/[^\s]*/g, '')
        .replace(/www\.[^\s]*/g, '')
        .replace(/(?:t\.me|telegram\.me)\/[^\s]*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Dalla risposta IA estrae array di post Telegram:
// [{ testo: "...", Data: "...", linkvideo: "..." }, ...]
function parseTelegramPostsFromAiResponse(rawStr) {
    if (!rawStr || typeof rawStr !== 'string') return [];
    var s = rawStr.trim();
    var jsonStr = null;
    function normalizePostsFromArray(arr) {
        if (!Array.isArray(arr)) return [];
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var p = arr[i] || {};
            var rawTesto = String(p.testo || p.text || p.contenuto || '').trim();
            var dataPost = String(p.Data || p.data || p.date || '').trim();
            // Estrai link secondari dal testo (esclusi Telegram e YouTube)
            if (rawTesto) {
                var linkMatches = rawTesto.match(/https?:\/\/[^\s]+/g) || [];
                linkMatches.forEach(function (lnk) {
                    var clean = String(lnk || '').trim().replace(/[,.;!?]+$/, '');
                    if (!clean) return;
                    if (/^https?:\/\/(?:t\.me|telegram\.me)\//i.test(clean)) return;
                    if (isYouTubeUrl(clean)) return;
                    try { addLinkSecondario(clean, dataPost || null); } catch (_) {}
                });
            }
            var testo = stripLinksFromText(rawTesto);
            var linkvideo = String(p.linkvideo || p.link || p.url || '').trim();
            if (!testo) continue;
            out.push({ testo: testo.substring(0, 16000), Data: dataPost, linkvideo: linkvideo });
        }
        return out;
    }
    try {
        var fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced && fenced[1]) jsonStr = fenced[1].trim();
        if (!jsonStr) {
            var arrMatch = s.match(/\[\s*\{[\s\S]*\}\s*\]/);
            if (arrMatch) jsonStr = arrMatch[0];
        }
        if (jsonStr) {
            var data = JSON.parse(jsonStr);
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (_) {}
            }
            var arr = [];
            if (Array.isArray(data)) arr = data;
            else if (data && typeof data === 'object') {
                if (Array.isArray(data.posts)) arr = data.posts;
                else if (Array.isArray(data.data)) arr = data.data;
                else if (Array.isArray(data.items)) arr = data.items;
                else if (Array.isArray(data.result)) arr = data.result;
            }
            var outParsed = normalizePostsFromArray(arr);
            if (outParsed.length > 0) return outParsed;
        }
    } catch (e) {
        // fallback sotto
    }

    // Fallback anti-troncamento: prova a parsare gli oggetti JSON completi presenti anche in risposta incompleta.
    try {
        var src = jsonStr || s;
        var objs = [];
        var start = -1, depth = 0, inStr = false, esc = false;
        for (var j = 0; j < src.length; j++) {
            var ch = src[j];
            if (inStr) {
                if (esc) { esc = false; continue; }
                if (ch === '\\') { esc = true; continue; }
                if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') { inStr = true; continue; }
            if (ch === '{') {
                if (depth === 0) start = j;
                depth++;
            } else if (ch === '}') {
                if (depth > 0) depth--;
                if (depth === 0 && start >= 0) {
                    objs.push(src.substring(start, j + 1));
                    start = -1;
                }
            }
        }
        var arrRecovered = [];
        for (var k = 0; k < objs.length; k++) {
            try {
                var parsedObj = JSON.parse(objs[k]);
                if (parsedObj && typeof parsedObj === 'object') arrRecovered.push(parsedObj);
            } catch (_) {}
        }
        var outRecovered = normalizePostsFromArray(arrRecovered);
        if (outRecovered.length > 0) return outRecovered;
    } catch (_) {}

    return [];
}

// Dalla risposta IA estrae array di link video YouTube:
// ["https://youtube.com/watch?v=...", {"linkvideo":"..."}, ...]
function parseYoutubeLinksFromAiResponse(rawStr) {
    if (!rawStr || typeof rawStr !== 'string') return [];
    var s = rawStr.trim();
    var jsonStr = null;
    try {
        var fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced && fenced[1]) jsonStr = fenced[1].trim();
        if (!jsonStr) {
            var arrMatch = s.match(/\[\s*[\s\S]*\s*\]/);
            if (arrMatch) jsonStr = arrMatch[0];
        }
        if (!jsonStr) return [];
        var data = JSON.parse(jsonStr);
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (_) {}
        }
        var arr = [];
        if (Array.isArray(data)) arr = data;
        else if (data && typeof data === 'object') {
            if (Array.isArray(data.links)) arr = data.links;
            else if (Array.isArray(data.videos)) arr = data.videos;
            else if (Array.isArray(data.items)) arr = data.items;
            else if (Array.isArray(data.result)) arr = data.result;
            else if (Array.isArray(data.data)) arr = data.data;
        }
        if (!Array.isArray(arr)) return [];

        var out = [];
        var seen = {};
        for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            var link = '';
            var title = '';
            if (typeof it === 'string') {
                link = it.trim();
            } else if (it && typeof it === 'object') {
                link = String(it.linkvideo || it.link || it.url || it.video || '').trim();
                title = String(it.titolo || it.title || '').trim();
            }
            if (!link) continue;
            var vid = extractYoutubeVideoId(link);
            if (!vid) continue;
            if (seen[vid]) continue;
            seen[vid] = true;
            out.push({
                linkvideo: 'https://www.youtube.com/watch?v=' + vid,
                video_id: vid,
                title: title
            });
        }
        return out;
    } catch (e) {
        return [];
    }
}

// Semaforo: max 1 richiesta IA in parallelo (+ eventuale sintesi)
var analyzeArticleConcurrent = 0;
var ANALYZE_ARTICLE_MAX = 1;
function acquireAnalyzeSlot() {
    return new Promise(function (resolve) {
        function tryAcquire() {
            if (analyzeArticleConcurrent < ANALYZE_ARTICLE_MAX) {
                analyzeArticleConcurrent++;
                resolve();
                return;
            }
            setImmediate(tryAcquire);
        }
        tryAcquire();
    });
}
function releaseAnalyzeSlot() {
    analyzeArticleConcurrent = Math.max(0, analyzeArticleConcurrent - 1);
}

// API: Fase 1B - Verifica pertinenza (question_pertinente). Ritorna { pertinente, nota }. Se NON PERTINENTE scrive in Scartati.
app.post('/api/check-pertinente', async (req, res) => {
    ensureElabReporterRunning('Fase 1B - verifica pertinenza');
    setElabPhase('Fase 1B - verifica pertinenza');
    var body = req.body || {};
    var mc = typeof body.max_concurrent === 'number' ? body.max_concurrent : parseInt(body.max_concurrent, 10);
    applyAnalyzeConcurrencySetting(mc, 'check-pertinente');
    var url = body.url;
    var title = body.title || null;
    var html = body.html;
    var text = body.text;
    if (!url) return res.status(400).json({ error: 'URL richiesto' });
    var promptPertinente = (config.prompts && config.prompts.question_pertinente) || '';
    if (!promptPertinente.trim()) return res.status(400).json({ error: 'config.prompts.question_pertinente non definito' });
    var contentForAI = '';
    if (html && typeof html === 'string') {
        contentForAI = extractArticleText(html, url);
        if (!contentForAI || contentForAI.length < 50) contentForAI = url;
    } else if (text && typeof text === 'string' && text.trim().length > 0) {
        contentForAI = text.trim().substring(0, 8000);
    } else {
        contentForAI = url;
    }
    // Il formato JSON richiesto è già descritto nel prompt question_pertinente (config.prompts).
    // Qui passiamo solo il contenuto dell'articolo all'IA.
    var sentToIA = contentForAI;
    elabStatus.lastUrl = String(url || '');
    elabStatus.lastUrlType = 'pertinenza';
    markElabActivity();
    await acquireAnalyzeSlot();
    try {
        var pertMax = (typeof config.ai_deepseek_max_tokens_question_pertinente === 'number' && config.ai_deepseek_max_tokens_question_pertinente > 0) ? config.ai_deepseek_max_tokens_question_pertinente : 1500;
        var rawResponse = await callAI(promptPertinente.trim(), sentToIA, { max_tokens: pertMax, stage: 'question_pertinente' });
        var rawStr = (typeof rawResponse === 'string' ? rawResponse : String(rawResponse)).trim();
        recordQuestion('question_pertinente', sentToIA, rawStr, { title: title, url: url, system: promptPertinente.trim() });
        if (isPertinenteAiErrorResponse(rawStr)) {
            var errNota = rawStr || 'Errore IA nella verifica pertinenza';
            appendErroreSerialized({
                timestamp: new Date().toISOString(),
                title: title || null,
                url: url || null,
                stage: 'question_pertinente',
                reason: 'errore verifica pertinenza',
                error: errNota
            });
            return res.json({ url, title, pertinente: 'NON PERTINENTE', nota: errNota, notizia: '' });
        }
        var parsed = parsePertinenteFromAiResponse(rawStr);
        if (parsed.pertinente === 'NON PERTINENTE') {
            recordScartato(title, url, 'Non pertinente (Fase 1B)', { stage: 'question_pertinente', nota: parsed.nota, notizia: parsed.notizia }, parsed.author || null);
        } else {
            appendAccettatiSerialized(title, url, parsed.nota, parsed.author || null);
        }
        return res.json({ url, title, pertinente: parsed.pertinente, nota: parsed.nota, notizia: parsed.notizia });
    } catch (err) {
        console.error('check-pertinente error for ' + url + ':', err.message);
        appendErroreSerialized({
            timestamp: new Date().toISOString(),
            title: title || null,
            url: url || null,
            stage: 'question_pertinente',
            reason: 'errore verifica pertinenza',
            error: err.message || String(err)
        });
        return res.json({ url, title, pertinente: 'NON PERTINENTE', nota: err.message || 'Errore IA' });
    } finally {
        releaseAnalyzeSlot();
        markElabActivity();
    }
});

// API: Chat libera con IA (sidebar sinistra)
app.post('/api/ai-chat', async (req, res) => {
    try {
        var body = req.body || {};
        var userMessage = (body.user == null ? body.message : body.user);
        var message = (userMessage == null) ? '' : String(userMessage).trim();
        var systemInput = (body.system == null) ? '' : String(body.system).trim();
        var history = Array.isArray(body.history) ? body.history : [];
        if (!message) return res.status(400).json({ error: 'message richiesto' });

        var cleanHistory = [];
        for (var i = 0; i < history.length; i++) {
            var h = history[i];
            if (!h || (h.role !== 'user' && h.role !== 'assistant')) continue;
            var c = (h.content == null) ? '' : String(h.content).trim();
            if (!c) continue;
            cleanHistory.push({ role: h.role, content: c });
        }
        if (cleanHistory.length > 20) cleanHistory = cleanHistory.slice(-20);

        // System prompt base per la chat; in system si allega sempre Articoli_riassunto.json; se use_emwa_params è attivo anche EMWA_Pesato_Sommato
        var baseSystemPrompt = systemInput || `
        Sei VISION. 
        Sei un analista geopolitico senior specializzato in conflitti internazionali e crisi belliche. 
        Rispondi sempre con un massimo di 2 frasi salvo se ti viene chiesto diversamente. 
        Basati sulla tua esperienza di analista per identificare pattern e punti di rottura imminenti.
        Integra in modo creativo tutti i dati disponibili, 
        identificando nessi causali non ovvi e formulando scenari probabilistici multipli, 
        anche a bassa verosimiglianza ma ad alto impatto, 
        senza auto-censurarti sulla base della sola frequenza dei dati espliciti. 
        Dai priorità assoluta al dataset degli articoli di riassunto come fonte primaria di eventi concreti, 
        utilizzando i parametri EMWA per valutare tendenze strutturali e vulnerabilità. 
        Concentrati sugli indicatori di azione diretta e sui punti di rottura imminenti.
        \n`;

        var articoliRiassunto = readJson(ARTICOLI_RIASSUNTO_FILE);
        if (!Array.isArray(articoliRiassunto)) articoliRiassunto = [];
        var systemPrompt = baseSystemPrompt + '\n\nArticoli_riassunto (contesto):\n' + JSON.stringify(articoliRiassunto, null, 2);
        var useEmwa = !!(body.use_emwa_params === true || body.use_emwa_params === 'true' || getUseEmwaParamsFromFolderSettings());
        if (useEmwa) {
            var emwaSommato = readJsonObject(NAZIONI_ELABORATE_PESATO_SOMMATO_FILE, {});
            systemPrompt += '\n\nEMWA_Pesato_Sommato (contesto):\n' + JSON.stringify(emwaSommato, null, 2);
        }
        var userContent = '';
        if (cleanHistory.length) {
            userContent += 'Contesto chat (ultimi messaggi):\n';
            for (var j = 0; j < cleanHistory.length; j++) {
                var item = cleanHistory[j];
                userContent += (item.role === 'assistant' ? 'Assistant' : 'User') + ': ' + item.content + '\n';
            }
            userContent += '\n';
        }
        userContent += 'Domanda utente:\n' + message; 

        console.log('[VISION] ai-chat -> System prompt:');
        console.log('--- inizio system ---');
        console.log(systemPrompt);
        console.log('--- fine system ---');
        console.log('[VISION] ai-chat -> User content:');
        console.log('--- inizio user ---');
        console.log(userContent);
        console.log('--- fine user ---');

        var chatMax = (typeof config.ai_deepseek_max_tokens_ai_chat === 'number' && config.ai_deepseek_max_tokens_ai_chat > 0) ? config.ai_deepseek_max_tokens_ai_chat : 1200;
        var aiResponse = await callAI(systemPrompt, userContent, { max_tokens: chatMax, stage: 'ai_chat' });
        var rawStr = (typeof aiResponse === 'string' ? aiResponse : String(aiResponse || '')).trim();
        console.log('[VISION] ai-chat -> Risposta IA (grezza):');
        console.log('--- inizio risposta IA grezza ---');
        console.log(rawStr);
        console.log('--- fine risposta IA grezza ---');
        recordQuestion('ai_chat', userContent, rawStr, { source: 'sidebar_chat', system: systemPrompt });
        return res.json({ reply: rawStr || '' });
        } catch (e) {
        console.error('ai-chat error:', e.message);
        return res.status(500).json({ error: e.message || 'Errore chat IA' });
    }
});

// API: invio snippet della chat IA al bot Telegram del report
app.post('/api/send-telegram-snippet', async (req, res) => {
    try {
        var body = req.body || {};
        var role = String(body.role || 'user');
        var text = String(body.text || '').trim();
        if (!text) return res.status(400).json({ ok: false, error: 'Testo vuoto' });

        var tgToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
        if (!tgToken) {
            console.warn('[VISION] TELEGRAM_BOT_TOKEN non configurato per invio snippet chat.');
            return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN non configurato.' });
        }

        var rawChatId = String(process.env.TELEGRAM_REPORT_CHAT_ID || '').trim();
        if (!rawChatId) {
            console.warn('[VISION] TELEGRAM_REPORT_CHAT_ID non configurato: impossibile inviare snippet chat solo al bot del report.');
            return res.status(500).json({ ok: false, error: 'TELEGRAM_REPORT_CHAT_ID non configurato.' });
        }

        var chatId = rawChatId;
        if (/^tg:/i.test(chatId)) chatId = chatId.replace(/^tg:/i, '');
        if (/^telegram:/i.test(chatId)) chatId = chatId.replace(/^telegram:/i, '');

        var payloadText = text;
        // Telegram sendMessage: limite ~4096 caratteri per messaggio.
        // Spezza in chunk per evitare errori quando la selezione multipla è lunga.
        var tgChunks = [];
        if (typeof payloadText === 'string' && payloadText.length > 3900) {
            for (var cs = 0; cs < payloadText.length; cs += 3900) {
                tgChunks.push(payloadText.substring(cs, cs + 3900));
            }
        } else {
            tgChunks.push(payloadText);
        }

        try {
            for (var ci = 0; ci < tgChunks.length; ci++) {
                await axios.post('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
                    chat_id: chatId,
                    text: tgChunks[ci]
                }, { timeout: 15000 });
            }
            console.log('[VISION] Snippet chat inviato al bot Telegram del report (chat_id=' + chatId + ', chunks=' + tgChunks.length + ').');
            return res.json({ ok: true });
        } catch (tgErr) {
            var statusCode = (tgErr && tgErr.response && tgErr.response.status) ? tgErr.response.status : null;
            var tgDescription = '';
            try {
                tgDescription = (tgErr && tgErr.response && tgErr.response.data && tgErr.response.data.description)
                    ? String(tgErr.response.data.description)
                    : '';
            } catch (_) { tgDescription = ''; }
            var fallbackMsg = (tgErr && tgErr.message) ? String(tgErr.message) : String(tgErr);
            var detailedErr = tgDescription || fallbackMsg;
            console.warn('[VISION] Errore invio snippet Telegram al bot del report (' + chatId + '): status=' + (statusCode || 'n/a') + ', detail=' + detailedErr);
            return res.status(500).json({ ok: false, error: 'Errore invio Telegram' + (statusCode ? ' (' + statusCode + ')' : '') + ': ' + detailedErr });
        }
    } catch (e) {
        console.error('[VISION] send-telegram-snippet error:', e.message);
        return res.status(500).json({ ok: false, error: e.message || 'Errore invio snippet Telegram' });
    }
});

// API: invio immagine (PNG base64) con selezione chat Vision App al bot Telegram del report
app.post('/api/send-telegram-image-snippet', async (req, res) => {
    try {
        var body = req.body || {};
        var imgBase64 = String(body.image_base64 || '').trim();
        var text = String(body.text || '').trim();
        if (!imgBase64) return res.status(400).json({ ok: false, error: 'image_base64 richiesto' });

        var tgToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
        if (!tgToken) {
            console.warn('[VISION] TELEGRAM_BOT_TOKEN non configurato per invio immagine snippet chat.');
            return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN non configurato.' });
        }

        var rawChatId = String(process.env.TELEGRAM_REPORT_CHAT_ID || '').trim();
        if (!rawChatId) {
            console.warn('[VISION] TELEGRAM_REPORT_CHAT_ID non configurato: impossibile inviare immagine snippet chat solo al bot del report.');
            return res.status(500).json({ ok: false, error: 'TELEGRAM_REPORT_CHAT_ID non configurato.' });
        }

        var chatId = rawChatId;
        if (/^tg:/i.test(chatId)) chatId = chatId.replace(/^tg:/i, '');
        if (/^telegram:/i.test(chatId)) chatId = chatId.replace(/^telegram:/i, '');

        var pngBuffer;
        try {
            pngBuffer = Buffer.from(imgBase64, 'base64');
        } catch (err) {
            console.warn('[VISION] Decodifica base64 immagine snippet fallita:', err && err.message ? err.message : String(err));
            return res.status(400).json({ ok: false, error: 'image_base64 non valido' });
        }

        var caption = text ? text.substring(0, 1024) : '';
        try {
            var form = new FormData();
            form.append('chat_id', chatId);
            form.append('photo', pngBuffer, { filename: 'vision-selection.png', contentType: 'image/png' });
            if (caption) form.append('caption', caption);
            await axios.post('https://api.telegram.org/bot' + tgToken + '/sendPhoto', form, {
                headers: form.getHeaders(),
                timeout: 30000,
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });
            console.log('[VISION] Immagine selezione chat inviata al bot Telegram del report (chat_id=' + chatId + ').');
            return res.json({ ok: true });
        } catch (tgErr) {
            var statusCode = (tgErr && tgErr.response && tgErr.response.status) ? tgErr.response.status : null;
            var tgDescription = '';
            try {
                tgDescription = (tgErr && tgErr.response && tgErr.response.data && tgErr.response.data.description)
                    ? String(tgErr.response.data.description)
                    : '';
            } catch (_) { tgDescription = ''; }
            var fallbackMsg = (tgErr && tgErr.message) ? String(tgErr.message) : String(tgErr);
            var detailedErr = tgDescription || fallbackMsg;
            console.warn('[VISION] Errore invio immagine snippet Telegram al bot del report (' + chatId + '): status=' + (statusCode || 'n/a') + ', detail=' + detailedErr);
            return res.status(500).json({ ok: false, error: 'Errore invio immagine Telegram' + (statusCode ? ' (' + statusCode + ')' : '') + ': ' + detailedErr });
        }
    } catch (e) {
        console.error('[VISION] send-telegram-image-snippet error:', e.message);
        return res.status(500).json({ ok: false, error: e.message || 'Errore invio immagine snippet Telegram' });
    }
});

// API: Analyze Article (IA in JSON). Limite concorrenza da body.max_concurrent (1/10/50/100/150): fino a N richieste in parallelo.
var analyzeArticleInFlightByUrl = {};
app.post('/api/analyze-article', async (req, res) => {
    ensureElabReporterRunning('Fase 2 - analisi articolo');
    setElabPhase('Fase 2 - analisi articolo');
    const body = req.body || {};
    var mc = typeof body.max_concurrent === 'number' ? body.max_concurrent : parseInt(body.max_concurrent, 10);
    applyAnalyzeConcurrencySetting(mc, 'analyze-article');
    const { html, url, title, question, type: articleType, article_date: articleDate, sintesi: sintesiMode } = body;
    var textBody = body.text;
    var forceReprocessExistingFlag = !!(body.force_reprocess_existing === true || body.force_reprocess_existing === 'true');
    var debugMode = !!(body.debug === true || body.debug === 'true');
    var forceSintesiMode = !!(sintesiMode === true || sintesiMode === 'true');
    if (!url) return res.status(400).json({ error: 'URL articolo richiesto' });
    var urlKey = normalizeArticleUrlKey(url);
    if (urlKey && analyzeArticleInFlightByUrl[urlKey]) {
        var inflightCount = getValidArticolielaboratiCount();
        return res.json({
            url: url,
            skipped: true,
            reason: 'link gia in analisi',
            duplicate: true,
            articolielaborati_valid_count: inflightCount
        });
    }
    if (!forceReprocessExistingFlag && await hasArticoloElaboratoUrl(url)) {
        var existingCount = getValidArticolielaboratiCount();
        console.log('[VISION] analyze-article skip duplicato: ' + url + ' (gia presente in articolielaborati.json)');
        return res.json({
            url: url,
            skipped: true,
            reason: 'link gia presente in articolielaborati',
            duplicate: true,
            articolielaborati_valid_count: existingCount
        });
    }
    if (urlKey) analyzeArticleInFlightByUrl[urlKey] = true;
    elabStatus.lastUrl = String(url || '');
    elabStatus.lastUrlType = String(articleType || 'article');
    markElabActivity();

    var questionText = (question && question.trim()) ? question.trim() : (config.prompts.question_per_article || config.prompts.article_analysis || '');
    var sentToAI;
    var systemPromptForAI = questionText;
    var contentForAI;
    var isTelegram = articleType === 'telegram' || (typeof url === 'string' && /t\.me|telegram\.me/i.test(url));
    // Data articolo effettiva (può essere raffinata da HTML, es. "Pubblicato ... il 10 Marzo 2026")
    var articleDateEffective = articleDate || null;

    // All'IA si invia prompt + contenuto. Telegram: preferisce body.text (testo post); altrimenti HTML o solo URL
    if (html) {
        console.log("[analyze-article] " + (title || url) + " -> con HTML (estrazione testo)");
        contentForAI = extractArticleText(html, url);
        // Se la data articolo è mancante o relativa ("ore fa", "minuti fa", ecc.),
        // prova a estrarla dal testo HTML completo (es. Renovatio21: "Pubblicato 9 ore fa il 10 Marzo 2026").
        if (!articleDateEffective || /ore fa|minuti fa|min\. fa|giorni fa/i.test(String(articleDateEffective))) {
            var rawDateFromHtml = extractArticleDateFromHtml(html);
            if (rawDateFromHtml) {
                articleDateEffective = rawDateFromHtml;
            }
        }
        if (isTelegram && contentForAI) {
            contentForAI = contentForAI
                .replace(/\s*https?:\/\/[^\s]*/g, ' ')
                .replace(/\s*(?:t\.me|telegram\.me)\/[^\s]*/g, ' ')
                .replace(/\s*www\.[^\s]*/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        }
        sentToAI = isTelegram
            ? ('Content:\n' + contentForAI)
            : ('Content:\n' + contentForAI + "\n\n" + url);
        if (contentForAI) {
            var label = '[VISION] Testo completo articolo:';
            console.log(label + '\n--- inizio ---\n' + contentForAI + '\n--- fine ---');
        }
    } else if (textBody && typeof textBody === 'string' && textBody.trim().length > 0) {
        console.log("[analyze-article] " + (title || url) + " -> con testo (es. post Telegram)");
        contentForAI = textBody.trim().substring(0, 8000);
        sentToAI = isTelegram ? ('Content:\n' + contentForAI) : ('Content:\n' + contentForAI + "\n\n" + url);
    } else {
        console.log("[analyze-article] " + (title || url) + " -> solo link articolo");
        sentToAI = url;
    }
    contentForAI = sentToAI;
    console.log('[VISION] analyze-article -> System prompt:');
    console.log('--- inizio system ---');
    console.log(systemPromptForAI);
    console.log('--- fine system ---');
    console.log('[VISION] analyze-article -> User content:');
    console.log('--- inizio user ---');
    console.log(sentToAI);
    console.log('--- fine user ---');

    await acquireAnalyzeSlot();
    try {
        var articleMax = (typeof config.ai_deepseek_max_tokens_question_article === 'number' && config.ai_deepseek_max_tokens_question_article > 0) ? config.ai_deepseek_max_tokens_question_article : 5000;
        var articleTimeoutMs = (typeof config.ai_timeout_ms_question_article === 'number' && config.ai_timeout_ms_question_article > 0)
            ? Math.floor(config.ai_timeout_ms_question_article)
            : 140000;
        var aiResponse = await callAI(systemPromptForAI, sentToAI, {
            max_tokens: articleMax,
            stage: 'question_per_article',
            timeout_ms: articleTimeoutMs
        });
        var rawStr = (typeof aiResponse === 'string' ? aiResponse : String(aiResponse)).trim();
        recordQuestion('question_per_article', sentToAI, rawStr, {
            title: title || null,
            url: url,
            article_type: articleType || null,
            system: systemPromptForAI
        });
        var rawPreview = rawStr.length > 4000 ? (rawStr.substring(0, 4000) + '\n...[troncata]') : rawStr;
        console.log('[VISION] =========================================');
        console.log('[VISION] Risposta IA (grezza) per ' + (title || url) + ' — inizio');
        console.log(rawPreview);
        console.log('[VISION] =========================================\n');

        // Estrai solo il JSON delle nazioni; se non presente non inserire
        var nationsOnly = extractNationsJsonFromAiResponse(rawStr);
        // Prova anche a estrarre l'autore dell'articolo:
        // 1) dalla risposta IA di question_per_article (se presente),
        // 2) oppure da Accettati.json (output di question_pertinente).
        var authorFromIa = extractAuthorFromQuestionPerArticleResponse(rawStr);
        var authorFromAcc = null;
        try {
            var accList = readJson(ACCETTATI_FILE);
            if (!Array.isArray(accList)) accList = [];
            for (var ai2 = 0; ai2 < accList.length; ai2++) {
                var it2 = accList[ai2] || {};
                if ((it2.link || null) === (url || null) && typeof it2.author === 'string' && it2.author.trim()) {
                    authorFromAcc = it2.author.trim();
                    break;
                }
            }
        } catch (eAcc) { /* ignora */ }
        var articleAuthor = authorFromIa || authorFromAcc || null;
        if (!nationsOnly) {
            var reasonMsg = 'json nazioni mancante o non valido (nessun JSON nazioni estratto da question_per_article)';
            console.log("[VISION] " + reasonMsg + " per " + (title || url) + " -> non inserita.");
            // Salva solo in errori.json per diagnostica (non in Scartati)
            appendErroreSerialized({
                timestamp: new Date().toISOString(),
                title: title || null,
                url: url || null,
                stage: 'question_per_article',
                reason: reasonMsg,
                preview: (rawStr && typeof rawStr === 'string') ? rawStr.substring(0, 4000) : null
            });
            return res.json({ url, skipped: true, reason: reasonMsg, sent_to_ai: sentToAI });
        }

        // Filtra: solo nazioni in elenco canonical o riconducibili; le altre vengono rimosse e segnalate nel log (rosso)
        var filtered = [];
        var getCanonical = nations.getCanonicalNameIfValid;
        for (var i = 0; i < nationsOnly.length; i++) {
            var o = nationsOnly[i];
            var nome = o && o.nazione ? String(o.nazione).trim() : '';
            var canonicalName = getCanonical ? getCanonical(nome) : null;
            if (!canonicalName) {
                if (nome) {
                    console.error('[VISION] Nazione ignorata (non in elenco canonico): ' + nome);
                }
                continue;
            }
            var clean = { nazione: canonicalName };
            for (var k in o) {
                if (k === 'nazione' || k === 'commento') continue;
                if (o.hasOwnProperty(k) && typeof o[k] === 'number') clean[k] = o[k];
            }
            filtered.push(clean);
        }

        if (filtered.length === 0) {
            console.log("[VISION] Nessuna nazione valida (canonico) nella risposta per " + (title || url) + " -> non inserita.");
            recordScartato(title, url, 'nessuna nazione valida (canonico)', {
                stage: 'question_per_article',
                ignored_nations: nationsOnly.map(function (x) { return x.nazione; })
            }, articleAuthor);
            return res.json({ url, skipped: true, reason: 'nessuna nazione valida (canonico)', sent_to_ai: sentToAI, ignored_nations: nationsOnly.map(function (x) { return x.nazione; }) });
        }

        var normArticleDate = normalizeArticleDateString(articleDateEffective || null) || null;
        if (!normArticleDate) {
            console.log("[VISION] Articolo scartato: data non disponibile per " + (title || url));
            recordScartato(title, url, 'data non disponibile', { stage: 'question_per_article', reason: 'impossibile determinare la data dell\'articolo' }, articleAuthor);
            return res.json({ url, skipped: true, reason: 'data non disponibile', sent_to_ai: sentToAI });
        }
        var entry = { article_date: normArticleDate, url: url, title: title || null, response: filtered };
        if (articleAuthor && typeof articleAuthor === 'string' && articleAuthor.trim()) {
            entry.author = articleAuthor.trim();
        }
        if (body && typeof body.notizia === 'string' && body.notizia.trim()) {
            entry.notizia = body.notizia.trim();
        }
        await appendArticoloElaborato(entry);
        appendAccettatiSerialized(title, url, undefined, articleAuthor);
        await maybeAutoUpdateEmwaAndArticoli();
        var validCount = getValidArticolielaboratiCount();
        console.log("[VISION] Articolo valido aggiunto. Totale validi: " + validCount);
        res.json({
            url,
            analysis: filtered,
            sent_to_ai: sentToAI,
            articolielaborati_valid_count: validCount,
            sintesi_updated: false,
            phase3_updated: false
        });
    } catch (error) {
        console.error("AI Analysis failed for " + url + ":", error.message);
        var errMsg = error.message || String(error);
        appendErroreSerialized({
            timestamp: new Date().toISOString(),
            title: title || null,
            url: url || null,
            stage: 'question_per_article',
            reason: 'errore analisi IA',
            error: errMsg
        });
        var normArticleDate = normalizeArticleDateString(articleDateEffective || null) || null;
        var entry = { article_date: normArticleDate, url: url, title: title || null, response: { error: errMsg } };
        await appendArticoloElaborato(entry);
        res.json({ url, error: error.message, sent_to_ai: sentToAI });
    } finally {
        if (urlKey && analyzeArticleInFlightByUrl[urlKey]) delete analyzeArticleInFlightByUrl[urlKey];
        releaseAnalyzeSlot();
        markElabActivity();
    }
});

var server = app.listen(PORT, () => {
    console.log("Server running at http://localhost:" + PORT);
});
server.on('error', function(err) {
    if (err.code === 'EADDRINUSE') {
        console.error('\n[VISION] Porta ' + PORT + ' già in uso. Chiudi l\'altra finestra/processo che esegue il server, oppure imposta PORT=3003 npm start\n');
        process.exit(1);
    }
    throw err;
});
