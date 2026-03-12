const axios = require('axios');
const cheerio = require('cheerio');

// --- Helper Date ---
const isRecent = (dateString) => {
    if (!dateString) {
        console.log(`[Date Check] No date string found.`);
        return false;
    }
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
        console.log(`[Date Check] Invalid date format: ${dateString}`);
        return false;
    }
    const now = new Date();
    const yesterdayMidnight = new Date(now);
    yesterdayMidnight.setDate(now.getDate() - 1);
    yesterdayMidnight.setHours(0, 0, 0, 0);

    const isRecent = date >= yesterdayMidnight;
    console.log(`[Date Check] Article Date: ${date.toISOString()} | Cutoff: ${yesterdayMidnight.toISOString()} | Result: ${isRecent ? 'KEEP' : 'SKIP'}`);
    return isRecent;
};

// --- Strategies ---

const Strategies = {
    // 1. Generic / Blog
    generic: async (url, html) => {
        const $ = cheerio.load(html);
        
        let dateStr = $('meta[property="article:published_time"]').attr('content') ||
                      $('meta[name="pubdate"]').attr('content') ||
                      $('meta[name="date"]').attr('content') ||
                      $('time').attr('datetime') ||
                      $('time').first().text().trim();

        console.log(`[Generic Strategy] Date found: ${dateStr}`);

        if (isRecent(dateStr)) {
            const title = $('title').text().trim();
            let content = $('article').text().trim();
            if (!content || content.length < 100) content = $('main').text().trim();
            if (!content || content.length < 100) content = $('body').text().trim();
            
            return {
                valid: true,
                title,
                date: dateStr,
                content: content.substring(0, 8000)
            };
        }
        return { valid: false, reason: "Date too old or not found" };
    },

    // 2. Facebook (Placeholder - Scraping FB is hard without API/Puppeteer)
    facebook: async (url, html) => {
        console.log("[Facebook Strategy] Detected Facebook URL");
        // FB scraping usually requires Selenium/Puppeteer and login.
        // For this MVP, we return a warning or try basic meta tags.
        // FB public pages *might* show some content in meta description.
        const $ = cheerio.load(html);
        const title = $('title').text().trim();
        const content = $('meta[name="description"]').attr('content') || "Facebook content hidden behind login/JS.";
        
        // Date is hard on FB static HTML. We assume valid if we can reach it, or skip.
        // Let's assume valid for now to show flow, but mark as "Needs Verification"
        return {
            valid: true, 
            title: `[FB] ${title}`,
            date: new Date().toISOString(), // Fallback to now
            content: content
        };
    },

    // 3. Instagram (Placeholder)
    instagram: async (url, html) => {
        console.log("[Instagram Strategy] Detected Instagram URL");
        // Similar to FB, hard to scrape.
        const $ = cheerio.load(html);
        const title = $('title').text().trim();
        const content = $('meta[name="description"]').attr('content') || "Instagram content hidden.";
        
        return {
            valid: true,
            title: `[IG] ${title}`,
            date: new Date().toISOString(),
            content: content
        };
    }
};

// --- Main Scraper Function ---
const scrapeUrl = async (url) => {
    try {
        console.log(`Fetching ${url}...`);
        const { data } = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36' 
            },
            timeout: 10000
        });

        // Determine Strategy
        let strategy = Strategies.generic;
        if (url.includes('facebook.com')) strategy = Strategies.facebook;
        else if (url.includes('instagram.com')) strategy = Strategies.instagram;

        return await strategy(url, data);

    } catch (error) {
        console.error(`Error processing ${url}:`, error.message);
        return { valid: false, error: error.message };
    }
};

module.exports = { scrapeUrl };
