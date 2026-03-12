const BaseScraper = require('./BaseScraper');
const cheerio = require('cheerio');
const axios = require('axios');
const config = require('../config');

function isLoginWall(html) {
    const s = String(html || '').toLowerCase();
    return s.includes('accedi o iscriviti per visualizzare') ||
        s.includes('iscriviti a facebook o accedi per continuare') ||
        s.includes('login.php?next=') ||
        s.includes('content not found') ||
        s.includes('contenuto non trovato');
}

function isProbablyHtml(html) {
    const s = String(html || '').toLowerCase();
    return s.includes('<html') || s.includes('<?xml') || s.includes('<!doctype');
}

function toMUrls(url) {
    const out = [];
    const src = String(url || '').trim();
    if (!src) return out;
    out.push(src);
    out.push(src.replace('://www.facebook.com', '://m.facebook.com').replace('://facebook.com', '://m.facebook.com'));
    out.push(src.replace('://www.facebook.com', '://mbasic.facebook.com').replace('://facebook.com', '://mbasic.facebook.com'));
    return Array.from(new Set(out));
}

function parseFacebookPosts(html, baseUrl) {
    const $ = cheerio.load(html || '');
    const posts = [];

    const selectors = [
        'a[href*="/posts/"]',
        'a[href*="story.php"]',
        'a[href*="permalink.php"]',
        'a[href*="/photos/"]'
    ];

    selectors.forEach((sel) => {
        $(sel).each((_, a) => {
            const href = $(a).attr('href');
            if (!href) return;
            let fullUrl = '';
            try { fullUrl = new URL(href, baseUrl).href; } catch (_) { return; }
            if (!/facebook\.com/i.test(fullUrl)) return;

            const container = $(a).closest('article, div');
            let text = container.text().replace(/\s+/g, ' ').trim();
            if (!text) text = $(a).text().replace(/\s+/g, ' ').trim();
            if (text.length < 6) return;

            const title = text.length > 120 ? text.substring(0, 117) + '...' : text;
            const existing = posts.find(p => p.url === fullUrl);
            if (!existing) {
                posts.push({ url: fullUrl, title, text });
            }
        });
    });

    return posts;
}

class FacebookScraper extends BaseScraper {
    async fetchHtml() {
        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            // Niente br: in alcuni casi arriva corpo non decodificabile
            'Accept-Encoding': 'gzip, deflate',
            'Upgrade-Insecure-Requests': '1'
        };

        const fbCookie = (process.env.FACEBOOK_COOKIE || config.facebook_cookie || '').trim();
        if (fbCookie) headers['Cookie'] = fbCookie;

        const opts = {
            headers,
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: () => true,
            responseType: 'text',
            decompress: true,
            maxContentLength: 10 * 1024 * 1024,
            maxBodyLength: 10 * 1024 * 1024
        };

        let lastHtml = '';
        let lastUrl = this.url;
        let lastStatus = 0;
        let sawLoginWall = false;

        const candidates = toMUrls(this.url);
        for (const u of candidates) {
            const res = await axios.get(u, opts);
            lastStatus = res.status;
            lastHtml = typeof res.data === 'string' ? res.data : '';
            lastUrl = u;
            if (res.status >= 400) continue;
            if (!isProbablyHtml(lastHtml)) continue;
            if (isLoginWall(lastHtml)) {
                sawLoginWall = true;
                continue;
            }
            if (!isLoginWall(lastHtml)) {
                return { html: lastHtml, url: u };
            }
        }

        if (sawLoginWall || isLoginWall(lastHtml)) {
            throw new Error('Facebook richiede autenticazione per leggere i post pubblici di questa pagina. Imposta FACEBOOK_COOKIE (o config.facebook_cookie) con una sessione valida.');
        }
        throw new Error('Facebook blocca l\'accesso automatico (HTTP ' + lastStatus + ') su ' + lastUrl + '.');
    }

    async scrape() {
        console.log(`[FacebookScraper] Fetching HTML for ${this.url}`);
        try {
            const data = await this.fetchHtml();
            const html = data.html;
            const finalUrl = data.url || this.url;
            const $ = cheerio.load(html || '');
            const posts = parseFacebookPosts(html, finalUrl);
            if (posts.length > 0) {
                console.log(`[FacebookScraper] Trovati ${posts.length} post`);
            } else {
                const fbCookie = (process.env.FACEBOOK_COOKIE || config.facebook_cookie || '').trim();
                if (!fbCookie) {
                    return {
                        url: this.url,
                        error: 'Facebook non espone i post in HTML senza sessione. Imposta FACEBOOK_COOKIE (o config.facebook_cookie) e riprova.'
                    };
                }
                return {
                    url: this.url,
                    error: 'Sessione Facebook attiva ma nessun post leggibile trovato. Prova URL diretto dei post o aggiorna il cookie.'
                };
            }
            return {
                type: 'raw_html',
                url: this.url,
                html: $.html(),
                title: $('title').text().trim() || this.url,
                original_type: 'facebook',
                fb_posts: posts
            };
        } catch (e) {
            console.error('[FacebookScraper] Error:', e.message);
            return { url: this.url, error: e.message || 'Accesso Facebook fallito' };
        }
    }
}

module.exports = FacebookScraper;
