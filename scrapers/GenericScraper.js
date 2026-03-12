const BaseScraper = require('./BaseScraper');
const cheerio = require('cheerio');

class GenericScraper extends BaseScraper {
    async scrape() {
        console.log(`[GenericScraper] Fetching HTML for ${this.url}`);
        const $ = await this.fetchHtml();
        
        // Return raw HTML for frontend processing
        // We use $.html() to get the stringified HTML from Cheerio
        return {
            type: 'raw_html',
            url: this.url,
            html: $.html(),
            title: $('title').text().trim() || this.url
        };
    }
}

module.exports = GenericScraper;
