const GenericScraper = require('./GenericScraper');
const TelegramScraper = require('./TelegramScraper');
const RssScraper = require('./RssScraper');

class ScraperFactory {
    static getScraper(url, type = 'blog') {
        if (!url) return null;
        if (type === 'telegram') return new TelegramScraper(url);
        if (type === 'rss') return new RssScraper(url);
        if (type === 'blog') return new GenericScraper(url);
        return new GenericScraper(url);
    }
}

module.exports = ScraperFactory;
