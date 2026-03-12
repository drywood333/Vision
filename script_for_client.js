// Vision AI - Client Static Version
// Rimossa logica di gestione ed elaborazione server-side

// CONFIGURAZIONE SORGENTE DATI
// Per far funzionare il Client aperto come file locale (file://), bisogna puntare a un server HTTP (locale o remoto)
// Server Locale VISION (assicurati che sia avviato su porta 3002):
const DATA_BASE_URL = 'http://localhost:3002/Json/';
// Server Online (se preferisci i dati di produzione):
// const DATA_BASE_URL = 'https://progredire.net/VISION/Json/';

let nationSintesi = { byCode: {}, byNation: {} };
let nationSintesiIa = { byCode: {}, byNation: {} };
let nationSintesiAlternativa = { byCode: {}, byNation: {} };
let nationEmwaIa = { byCode: {}, byNation: {} };
let nationNote = { byCode: {}, byNation: {} };
let nationSintesiV4 = { byCode: {}, byNation: {} };
let nationSintesiV5 = { byCode: {}, byNation: {} };
let nationSintesiElabIa = { byCode: {}, byNation: {} };

let map = null;
let isMapPointerDown = false;
let bubbleMoveRaf = null;
let bubbleRebuildTimer = null;

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

function colorFromMetric(val) {
    var n = parseInt(val, 10);
    if (isNaN(n)) return '#6b7280';
    if (n <= 7) return '#ef4444';
    if (n <= 30) return '#f59e0b';
    if (n <= 60) return '#eab308';
    if (n <= 90) return '#84cc16';
    return '#22c55e';
}

function getMarkersFromSintesi() {
    var out = [];
    var byCode = nationSintesi.byCode || {};
    for (var code in byCode) {
        if (!byCode.hasOwnProperty(code)) continue;
        var info = byCode[code];
        var coords = COUNTRY_COORDS[code.toLowerCase()];
        if (!coords) continue;
        var gg = info.gg != null ? String(info.gg).trim() : '';
        var gr = info.gr != null ? String(info.gr).trim() : '';
        var ggNum = parseInt(gg, 10);
        var grNum = parseInt(gr, 10);
        var hasRelevantMetric = (!isNaN(ggNum) && ggNum < 365) || (!isNaN(grNum) && grNum < 365);
        //if (!hasRelevantMetric) continue; // <-- Filtro rimosso per mostrare tutte le nazioni presenti nel JSON
        var minDays = NaN;
        if (!isNaN(ggNum) && !isNaN(grNum)) minDays = Math.min(ggNum, grNum);
        else if (!isNaN(ggNum)) minDays = ggNum;
        else if (!isNaN(grNum)) minDays = grNum;
        var bubbleColor = colorFromMetric(isNaN(minDays) ? '' : String(minDays));
        var nazione = (info.nazione || '').trim() || (nationSintesi.byCode && nationSintesi.byCode[code] && nationSintesi.byCode[code].nazione) || code;
        out.push({
            name: formatSintesiLabel(info),
            coords: coords,
            nazione: nazione,
            ggNum: ggNum,
            grNum: grNum,
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
        const res = await fetch(DATA_BASE_URL + 'sintesinazioni.json');
        const data = await res.json();
        nationSintesi.byCode = data.byCode || {};
        nationSintesi.byNation = data.byNation || {};
        hideMapTooltips();
        if (map && typeof map.removeMarkers === 'function' && typeof map.addMarkers === 'function') {
            map.removeMarkers();
            map.addMarkers(getMarkersFromSintesi());
            scheduleBubbleRebuild(150);
        }
        if (map && typeof map.updateSize === 'function') map.updateSize();
    } catch (e) { /* ignora */ }
}

async function refreshNationSintesiIaPesata() {
    try {
        const res = await fetch(DATA_BASE_URL + 'sintesiNazioniElaborate_IA.json');
        const data = await res.json();
        nationSintesiIa.byCode = data.byCode || {};
        nationSintesiIa.byNation = data.byNation || {};
    } catch (e) { /* ignora */ }
}

async function refreshNationSintesiAlternativa() {
    try {
        const res = await fetch(DATA_BASE_URL + 'sintesialternativa.json');
        const data = await res.json();
        hideMapTooltips();
    } catch (e) { /* ignora */ }
}

async function refreshNationEmwaIa() {
    try {
        const res = await fetch(DATA_BASE_URL + 'nazioniEMWA_IA.json');
        const data = await res.json();
        hideMapTooltips();
    } catch (e) { /* ignora */ }
}

async function refreshNationNote() {
    try {
        const res = await fetch(DATA_BASE_URL + 'note.json');
        const data = await res.json();
        nationNote.byCode = data.byCode || {};
        nationNote.byNation = data.byNation || {};
        hideMapTooltips();
    } catch (e) { /* ignora */ }
}

async function refreshNationSintesiV4() {
    try {
        const res = await fetch(DATA_BASE_URL + 'sintesiV4.json');
        const data = await res.json();
        hideMapTooltips();
        if (map && typeof map.removeMarkers === 'function' && typeof map.addMarkers === 'function') {
            map.removeMarkers();
            map.addMarkers(getMarkersFromSintesi());
            scheduleBubbleRebuild(150);
        }
        if (map && typeof map.updateSize === 'function') map.updateSize();
    } catch (e) { /* ignora */ }
}

async function refreshNationSintesiV5() {
    try {
        const res = await fetch(DATA_BASE_URL + 'sintesiV5.json');
        const data = await res.json();
        hideMapTooltips();
        if (map && typeof map.removeMarkers === 'function' && typeof map.addMarkers === 'function') {
            map.removeMarkers();
            map.addMarkers(getMarkersFromSintesi());
            scheduleBubbleRebuild(150);
        }
        if (map && typeof map.updateSize === 'function') map.updateSize();
    } catch (e) { /* ignora */ }
}

async function refreshNationSintesiElabIa() {
    try {
        const res = await fetch(DATA_BASE_URL + 'sintesiNazioniElaborate_IA.json');
        const data = await res.json();
        nationSintesiElabIa.byCode = data.byCode || {};
        nationSintesiElabIa.byNation = data.byNation || {};
        if (map && typeof map.removeMarkers === 'function' && typeof map.addMarkers === 'function') {
            map.removeMarkers();
            map.addMarkers(getMarkersFromSintesi());
            scheduleBubbleRebuild(150);
        }
        hideMapTooltips();
    } catch (e) { /* ignora */ }
}

async function refreshSintesiVRed() {
    try {
        const res = await fetch(DATA_BASE_URL + 'sintesiVRED.json');
        const data = await res.json();
        var panel = document.getElementById('urgent-panel');
        var msgEl = document.getElementById('urgent-message');
        var daysEl = document.getElementById('urgent-days');
        if (!panel || !msgEl || !daysEl) return;
        var msg = (data && (data.Messaggio != null && data.Messaggio !== '')) ? String(data.Messaggio).trim() : '';
        var days = (data && (data.Giorni != null && data.Giorni !== '')) ? String(data.Giorni).trim() : '';
        if (msg) {
            msgEl.textContent = msg;
            daysEl.textContent = days ? 'Giorni: ' + days : '';
        } else {
            msgEl.textContent = 'Nessun avviso globale disponibile.';
            daysEl.textContent = '';
        }
        panel.style.display = '';
    } catch (e) { /* ignora */ }
}

function wrapMarkerLabelsInBubbles() {
    var container = document.getElementById('world-map');
    if (!container) return;
    var svg = container.querySelector('svg');
    if (!svg) return;
    var labelsGroup = svg.querySelector('#jvm-markers-labels-group');
    var markersGroup = svg.querySelector('#jvm-markers-group');
    if (!labelsGroup || !markersGroup) return;
    var paddingX = 10;
    var paddingY = 4;
    var dotTextGap = 10;
    var rx = 10;

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
                        tspan.setAttribute('font-size', '1.2em');
                    }
                    if (j >= 1) {
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

            var dotRadius = (r || 5);
            var maxRadius = Math.max(3, (paddingX / 2) - 1);
            if (dotRadius > maxRadius) dotRadius = maxRadius;
            var dotCx = rectX + dotRadius + 2;
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

            var attachY = rectY + rectH;
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
        } catch (e) { }
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
            bubbleRebuildTimer = setTimeout(attempt, 100);
            return;
        }
        var labelsGroup = svg.querySelector('#jvm-markers-labels-group');
        var markersGroup = svg.querySelector('#jvm-markers-group');
        var hasTexts = labelsGroup && labelsGroup.querySelectorAll('text').length > 0;
        var hasMarkers = markersGroup && markersGroup.querySelectorAll('circle').length > 0;
        if (!hasTexts || !hasMarkers) {
            bubbleRebuildTimer = setTimeout(attempt, 120);
            return;
        }
        wrapMarkerLabelsInBubbles();
        updateMarkerBubblePositions();
    }
    bubbleRebuildTimer = setTimeout(attempt, initialDelay);
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

function escapeHtml(t) {
    if (!t) return '';
    var d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
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
                        var name = marker.nazione || marker.name || '';
                        var gg = marker.ggNum;
                        var gr = marker.grNum;
                        var label = name;
                        if (typeof gg === 'number' && !isNaN(gg)) label += ' (G:' + gg + ')';
                        if (typeof gr === 'number' && !isNaN(gr)) label += ' (N:' + gr + ')';
                        return label;
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
                var gg = (elabInfo && (elabInfo.gg != null || elabInfo.GG != null)) ? String(elabInfo.gg != null ? elabInfo.gg : elabInfo.GG) : '';
                var gr = (elabInfo && (elabInfo.gr != null || elabInfo.GR != null)) ? String(elabInfo.gr != null ? elabInfo.gr : elabInfo.GR) : '';
                var ggIa = (iaInfo && (iaInfo.gg != null || iaInfo.GG != null)) ? String(iaInfo.gg != null ? iaInfo.gg : iaInfo.GG) : '';
                var grIa = (iaInfo && (iaInfo.gr != null || iaInfo.GR != null)) ? String(iaInfo.gr != null ? iaInfo.gr : iaInfo.GR) : '';
                var ggNum = (gg !== '' && !isNaN(parseInt(gg, 10))) ? parseInt(gg, 10) : NaN;
                var grNum = (gr !== '' && !isNaN(parseInt(gr, 10))) ? parseInt(gr, 10) : NaN;
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
                var ggDisp = gg !== '' ? escapeHtml(displayMetric(gg)) : '–';
                var grDisp = gr !== '' ? escapeHtml(displayMetric(gr)) : '–';
                var ggIaDisp = ggIa !== '' ? escapeHtml(displayMetric(ggIa)) : '–';
                var grIaDisp = grIa !== '' ? escapeHtml(displayMetric(grIa)) : '–';
                var noteHtml = '';
                var noteVal = (nationNote.byCode && nationNote.byCode[c]) ? nationNote.byCode[c] : null;
                var noteText = '';
                var gaText = '';
                if (noteVal && typeof noteVal === 'object') {
                    if (noteVal.nota != null) noteText = String(noteVal.nota);
                    else if (noteVal.note != null) noteText = String(noteVal.note);
                    if (noteVal.GA != null) gaText = String(noteVal.GA);
                    else if (noteVal.ga != null) gaText = String(noteVal.ga);
                } else if (typeof noteVal === 'string') {
                    noteText = noteVal;
                }
                if (noteText || gaText) {
                    noteHtml = '<div class="vision-tooltip-note">';
                    if (noteText) noteHtml += escapeHtml(noteText);
                    if (gaText) {
                        if (noteText) noteHtml += '<br>';
                        noteHtml += '<span class="vision-tooltip-ga">Giorni di attuazione: ' + escapeHtml(displayMetric(gaText)) + '</span>';
                    }
                    noteHtml += '</div>';
                }
                var html = '<div class="vision-tooltip">' +
                    '<div class="vision-tooltip-title">' + escapeHtml(name) + '</div>' +
                    '<div class="vision-tooltip-metrics">Giorni alla Guerra: ' + ggDisp + '</div>' +
                    '<div class="vision-tooltip-metrics">Giorni al Nucleare: ' + grDisp + '</div>' +
                    '<div class="vision-tooltip-metrics">Giorni alla Guerra (IA): ' + ggIaDisp + '</div>' +
                    '<div class="vision-tooltip-metrics">Giorni al Nucleare (IA): ' + grIaDisp + '</div>' +
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
        var mapEl = document.getElementById('world-map');
        if (mapEl) {
            mapEl.addEventListener('pointerdown', function () { isMapPointerDown = true; }, { passive: true });
            mapEl.addEventListener('pointermove', function (e) {
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

document.addEventListener('DOMContentLoaded', async () => {
    await refreshNationSintesi();
    await refreshNationSintesiAlternativa();
    await refreshNationEmwaIa();
    await refreshNationNote();
    await refreshNationSintesiV4();
    await refreshNationSintesiV5();
    await refreshNationSintesiElabIa();
    await refreshSintesiVRed();
    
    initMap();
});
