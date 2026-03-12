const axios = require('axios');
const cheerio = require('cheerio');
const abortCheck = require('./abortCheck');
// const chrono = require('chrono-node'); // Disabled due to Node version incompatibility

class BaseScraper {
    constructor(url) {
        this.url = url;
    }

    sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    isTimeoutError(error) {
        if (!error) return false;
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return true;
        var msg = String(error.message || '').toLowerCase();
        return msg.indexOf('timeout') !== -1;
    }

    async fetchHtml() {
        const reqTimeoutMsRaw = parseInt(process.env.SCRAPER_TIMEOUT_MS || '45000', 10);
        const reqTimeoutMs = (isFinite(reqTimeoutMsRaw) && reqTimeoutMsRaw > 0) ? reqTimeoutMsRaw : 45000;
        const retriesRaw = parseInt(process.env.SCRAPER_TIMEOUT_RETRIES || '2', 10);
        const timeoutRetries = (isFinite(retriesRaw) && retriesRaw >= 0) ? retriesRaw : 2;
        const baseBackoffRaw = parseInt(process.env.SCRAPER_RETRY_BACKOFF_MS || '1000', 10);
        const baseBackoffMs = (isFinite(baseBackoffRaw) && baseBackoffRaw > 0) ? baseBackoffRaw : 1000;
        const maxAttempts = timeoutRetries + 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (abortCheck.check()) {
                throw new Error('Elaborazione annullata dall\'utente.');
            }
            try {
                console.log(`[BaseScraper] Requesting ${this.url}... (attempt ${attempt}/${maxAttempts}, timeout ${reqTimeoutMs}ms)`);
                const { data, status } = await axios.get(this.url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
                    },
                    timeout: reqTimeoutMs,
                    maxContentLength: 5 * 1024 * 1024, // Max 5MB
                    maxBodyLength: 5 * 1024 * 1024
                });
                console.log(`[BaseScraper] Received ${status} OK. Content-Length: ${data.length} chars.`);
                return cheerio.load(data);
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    console.error(`[BaseScraper] Error 404: Page not found at ${this.url}`);
                    // Return empty cheerio object to prevent crash downstream
                    return cheerio.load('');
                }

                var canRetryTimeout = this.isTimeoutError(error) && attempt < maxAttempts;
                if (canRetryTimeout) {
                    if (abortCheck.check()) {
                        throw new Error('Elaborazione annullata dall\'utente.');
                    }
                    var waitMs = baseBackoffMs * attempt;
                    console.warn(`[BaseScraper] Timeout on ${this.url} (attempt ${attempt}/${maxAttempts}). Retry in ${waitMs}ms...`);
                    await this.sleep(waitMs);
                    continue;
                }

                console.error(`Error fetching ${this.url}:`, error.message);
                throw error;
            }
        }
    }

    isRecent(dateString) {
        if (!dateString) return false;
        
        // 1. Try standard JS Date parsing
        let date = new Date(dateString);
        
        // 2. Fallback if invalid (chrono disabled)
        if (isNaN(date.getTime())) {
             return false;
        }

        const now = new Date();
        const cutoff = new Date(now.getTime() - (72 * 60 * 60 * 1000)); // 72 hours ago

        return date >= cutoff;
    }

    // Default implementation (can be overridden)
    async scrape() {
        throw new Error("Method 'scrape' must be implemented.");
    }
}

module.exports = BaseScraper;
