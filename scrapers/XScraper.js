const cheerio = require('cheerio');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// X (Twitter) restituisce "Something went wrong" e blocca i crawler.
// Usiamo Nitter (frontend alternativo) che fornisce HTML statico con i post.
const AGENT_OPTS = { maxHeaderSize: 262144 };
const httpsAgent = new https.Agent(AGENT_OPTS);
const httpAgent = new http.Agent(AGENT_OPTS);

const NITTER_INSTANCES = [
    'https://nitter.tiekoetter.com',
    'https://nitter.poast.org',
    'https://nitter.privacydev.net',
    'https://nitter.catsarch.com',
    'https://nitter.privacyredirect.com'
];

function extractUsername(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (!host.includes('x.com') && !host.includes('twitter.com')) return null;
        const m = parsed.pathname.match(/^\/([a-zA-Z0-9_]+)\/?/);
        return m ? m[1] : null;
    } catch (_) { return null; }
}

function fetchHtml(url, redirectCount, mode) {
    redirectCount = redirectCount || 0;
    mode = mode || 'default';
    if (redirectCount > 5) return Promise.reject(new Error('Troppi redirect'));
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const mod = isHttps ? https : http;
        const headers = (mode === 'nitter')
            ? { 'Accept': 'text/html,*/*;q=0.8' }
            : {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
            };
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: headers,
            timeout: 15000,
            agent: isHttps ? httpsAgent : httpAgent
        };

        const req = mod.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const next = new URL(res.headers.location, url).href;
                    if (next !== url) return fetchHtml(next, redirectCount + 1, mode).then(resolve).catch(reject);
                }
                resolve(body);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.setTimeout(15000);
        req.end();
    });
}

function parseNitterTweets(html, baseUrl) {
    const $ = cheerio.load(html || '');
    const posts = [];
    const base = new URL(baseUrl);
    $('.timeline-item, .tweet-body').each((_, el) => {
        const $el = $(el);
        const $link = $el.find('a.tweet-link, a[href*="/status/"]').first();
        const href = $link.attr('href');
        const $content = $el.find('.tweet-content, .tweet-body');
        const text = ($content.length ? $content.first() : $el).text().replace(/\s+/g, ' ').trim();
        const $time = $el.find('time');
        const dateAnchorTitle = $el.find('.tweet-date a').attr('title');
        const dateStr = $time.attr('datetime') || ($time.text().trim() || '') || dateAnchorTitle || null;
        if (href && text && text.length > 2) {
            let fullUrl = href.startsWith('/') ? (base.origin + href) : href;
            try {
                fullUrl = new URL(href, baseUrl).href;
            } catch (_) {}
            posts.push({
                url: fullUrl,
                title: text.length > 120 ? text.substring(0, 117) + '...' : text,
                text: text,
                date: dateStr
            });
        }
    });
    if (posts.length > 0) return posts;
    $('div[class*="tweet"]').each((_, el) => {
        const $el = $(el);
        const $link = $el.find('a[href*="/status/"]').first();
        const href = $link.attr('href');
        const text = $el.text().replace(/\s+/g, ' ').trim();
        if (href && text.length > 3 && text.length < 500) {
            let fullUrl = href.startsWith('/') ? (base.origin + href) : href;
            try {
                fullUrl = new URL(href, baseUrl).href;
            } catch (_) {}
            const $t = $el.find('time');
            const dateStr = $t.attr('datetime') || null;
            if (!posts.some(p => p.url === fullUrl)) {
                posts.push({
                    url: fullUrl,
                    title: text.length > 120 ? text.substring(0, 117) + '...' : text,
                    text: text,
                    date: dateStr
                });
            }
        }
    });
    return posts;
}

class XScraper {
    constructor(url) {
        this.url = url;
    }

    async scrape() {
        const username = extractUsername(this.url);
        console.log(`[XScraper] Profilo @${username || '?'}, uso Nitter per i post...`);
        if (!username) {
            return {
                url: this.url,
                error: 'URL X non valido. Inserisci un profilo: https://x.com/username'
            };
        }
        for (const instance of NITTER_INSTANCES) {
            const nitterUrl = instance + '/' + username;
            try {
                console.log(`[XScraper] Provo ${instance}...`);
                const html = await fetchHtml(nitterUrl, 0, 'nitter');
                const $ = cheerio.load(html || '');
                if ($('body').text().includes('Something went wrong') || $('title').text().includes('Error')) continue;
                const posts = parseNitterTweets(html, nitterUrl);
                if (posts.length > 0) {
                    console.log(`[XScraper] Trovati ${posts.length} post da ${instance}`);
                    return {
                        type: 'raw_html',
                        url: this.url,
                        html: $.html(),
                        title: $('title').text().trim() || `@${username}`,
                        original_type: 'x',
                        x_posts: posts,
                        x_nitter_base: instance
                    };
                }
            } catch (e) {
                console.log(`[XScraper] ${instance} fallito: ${e.message}`);
            }
        }
        return {
            url: this.url,
            error: 'Impossibile leggere i post da X: tutte le istanze Nitter hanno fallito. Riprova più tardi o incolla manualmente il testo.'
        };
    }
}

module.exports = XScraper;
