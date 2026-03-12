const BaseScraper = require('./BaseScraper');
const cheerio = require('cheerio');
const axios = require('axios');

class TelegramScraper extends BaseScraper {
    async scrape() {
        console.log(`[TelegramScraper] Fetching HTML for ${this.url}`);
        const $ = await this.fetchHtml();
        
        return {
            type: 'raw_html', // Return raw HTML for frontend processing
            url: this.url,
            html: $.html(),
            title: $('title').text().trim() || this.url,
            original_type: 'telegram' // Hint for frontend
        };
    }
}

module.exports = TelegramScraper;
