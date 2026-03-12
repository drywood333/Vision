const axios = require('axios');
const abortCheck = require('./abortCheck');

/**
 * Scraper per feed RSS/Atom (XML).
 * Restituisce il XML grezzo al frontend che estrae <channel><item> e <pubDate>.
 */
class RssScraper {
    constructor(url) {
        this.url = url;
    }

    async scrape() {
        const reqTimeoutMs = parseInt(process.env.SCRAPER_TIMEOUT_MS || '45000', 10) || 45000;
        console.log(`[RssScraper] Fetching XML for ${this.url}`);
        const { data } = await axios.get(this.url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*'
            },
            timeout: reqTimeoutMs,
            maxContentLength: 5 * 1024 * 1024,
            maxBodyLength: 5 * 1024 * 1024,
            responseType: 'text',
            validateStatus: function (status) { return status >= 200 && status < 300; }
        });
        const xmlString = typeof data === 'string' ? data : String(data || '');
        console.log(`[RssScraper] Received ${xmlString.length} chars.`);
        return {
            type: 'raw_xml',
            url: this.url,
            html: xmlString,
            title: this.url
        };
    }
}

module.exports = RssScraper;
