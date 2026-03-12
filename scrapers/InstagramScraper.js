const BaseScraper = require('./BaseScraper');
const cheerio = require('cheerio');
const axios = require('axios');

class InstagramScraper extends BaseScraper {
    async scrape() {
        console.log(`[InstagramScraper] Fetching HTML for ${this.url}`);
        // Return raw HTML for frontend to attempt parsing
        try {
            const $ = await this.fetchHtml();
            return {
                type: 'raw_html',
                url: this.url,
                html: $.html(),
                title: $('title').text().trim() || this.url,
                original_type: 'instagram'
            };
        } catch (e) {
            console.error("[InstagramScraper] Error:", e.message);
            return { url: this.url, error: "Accesso Instagram fallito" };
        }
    }
}

module.exports = InstagramScraper;
