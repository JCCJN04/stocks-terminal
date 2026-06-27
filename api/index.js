import express from 'express';
import cors    from 'cors';
import https   from 'https';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────
// SUPABASE
// ──────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jufpxbhjynbfemzfovox.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1ZnB4YmhqeW5iZmVtemZvdm94Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2NTQ5OTYsImV4cCI6MjA5NzIzMDk5Nn0.JzIibnBPgIX1H0rEIPFhEd--mhA2DjMM9sQuj1NqLKw';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    realtime: { transport: WebSocket },
});

app.get('/', (_, res) => {
    const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ──────────────────────────────────────────────
// YAHOO FINANCE SESSION (crumb + cookies)
// ──────────────────────────────────────────────

let yfSession = null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function httpsGet(url, hdrs) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.get(
            { hostname: u.hostname, path: u.pathname + u.search, headers: hdrs },
            res => {
                let body = '';
                const rawCookies = res.headers['set-cookie'] ?? [];
                res.on('data', d => body += d);
                res.on('end', () => resolve({ status: res.statusCode, rawCookies, body }));
            }
        );
        req.on('error', reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error('HTTPS timeout')); });
    });
}

function httpsPost(url, payload, hdrs) {
    return new Promise((resolve, reject) => {
        const u    = new URL(url);
        const data = JSON.stringify(payload);
        const req  = https.request(
            {
                hostname: u.hostname,
                path:     u.pathname + u.search,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    ...hdrs,
                },
            },
            res => {
                let body = '';
                res.on('data', d => body += d);
                res.on('end', () => resolve({ status: res.statusCode, body }));
            }
        );
        req.on('error', reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error('HTTPS timeout')); });
        req.write(data);
        req.end();
    });
}

async function getYFSession() {
    if (yfSession) return yfSession;

    const r1 = await httpsGet('https://finance.yahoo.com/', {
        'User-Agent':      UA,
        'Accept':          'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
    });
    const cookie = r1.rawCookies.map(c => c.split(';')[0]).join('; ');

    const r2 = await httpsGet('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        'User-Agent': UA,
        'Cookie':     cookie,
    });
    if (r2.status !== 200) throw new Error(`Crumb fetch failed: HTTP ${r2.status}`);

    const crumb = r2.body.trim();
    yfSession = { crumb, cookie };
    return yfSession;
}

async function yfFetch(url) {
    const { crumb, cookie } = await getYFSession();
    const sep = url.includes('?') ? '&' : '?';
    const full = `${url}${sep}crumb=${encodeURIComponent(crumb)}`;

    const r = await httpsGet(full, {
        'User-Agent': UA,
        'Cookie':     cookie,
        'Accept':     'application/json',
    });

    if (r.status === 401) {
        yfSession = null;
        const { crumb: c2, cookie: k2 } = await getYFSession();
        const r2 = await httpsGet(`${url}${sep}crumb=${encodeURIComponent(c2)}`, {
            'User-Agent': UA,
            'Cookie':     k2,
            'Accept':     'application/json',
        });
        if (r2.status !== 200) throw new Error(`Yahoo Finance HTTP ${r2.status}`);
        return JSON.parse(r2.body);
    }

    if (r.status !== 200) throw new Error(`Yahoo Finance HTTP ${r.status}`);
    return JSON.parse(r.body);
}

// ──────────────────────────────────────────────
// INDICADORES TÉCNICOS
// ──────────────────────────────────────────────

function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gainSum += d; else lossSum += Math.abs(d);
    }
    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcSMA(closes, period) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

function safeNum(v) {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}

// ──────────────────────────────────────────────
// FETCH DE DATOS
// ──────────────────────────────────────────────

async function fetchSummary(ticker) {
    const modules = 'financialData,defaultKeyStatistics,price,summaryDetail';
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`;
    const json = await yfFetch(url);
    if (json.quoteSummary?.error) throw new Error(json.quoteSummary.error.description || 'YF error');
    return json.quoteSummary?.result?.[0] ?? {};
}

async function fetchHistory(ticker) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
    const json = await yfFetch(url);
    if (json.chart?.error) throw new Error(json.chart.error.description || 'Chart error');
    const raw = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    return raw.filter(c => c != null && !isNaN(c));
}

// ──────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────

app.get('/api/data/:ticker', async (req, res) => {
    const ticker = req.params.ticker.toUpperCase().trim();
    try {
        const [summary, closes] = await Promise.all([
            fetchSummary(ticker),
            fetchHistory(ticker),
        ]);

        const fin    = summary.financialData        ?? {};
        const stats  = summary.defaultKeyStatistics ?? {};
        const price  = summary.price                ?? {};
        const detail = summary.summaryDetail        ?? {};

        const currentPrice = safeNum(fin.currentPrice?.raw  ?? price.regularMarketPrice?.raw);
        const targetPrice  = safeNum(fin.targetMeanPrice?.raw);
        const upside = (currentPrice && targetPrice)
            ? ((targetPrice - currentPrice) / currentPrice) * 100
            : null;

        res.json({
            ok:             true,
            ticker,
            companyName:    price.longName ?? price.shortName ?? ticker,
            currentPrice,
            change:         safeNum(price.regularMarketChange?.raw),
            changePct:      safeNum(price.regularMarketChangePercent?.raw) * 100,
            pe:             safeNum(stats.forwardPE?.raw),
            peg:            safeNum(stats.pegRatio?.raw),
            roe:            safeNum(fin.returnOnEquity?.raw),
            debtToEquity:   safeNum(fin.debtToEquity?.raw),
            targetPrice,
            analystRating:  fin.recommendationKey ?? 'n/a',
            upside,
            rsi:            calcRSI(closes),
            sma50:          calcSMA(closes, 50),
            sma200:         calcSMA(closes, 200),
            closesCount:    closes.length,
            marketCap:      safeNum(price.marketCap?.raw ?? detail.marketCap?.raw),
            beta:           safeNum(detail.beta?.raw),
            week52High:     safeNum(detail.fiftyTwoWeekHigh?.raw),
            week52Low:      safeNum(detail.fiftyTwoWeekLow?.raw),
            avgVolume:      safeNum(detail.averageVolume?.raw),
            volume:         safeNum(price.regularMarketVolume?.raw),
            revenueGrowth:  safeNum(fin.revenueGrowth?.raw),
            earningsGrowth: safeNum(fin.earningsGrowth?.raw),
            profitMargins:  safeNum(fin.profitMargins?.raw),
            freeCashflow:   safeNum(fin.freeCashflow?.raw),
            currentRatio:   safeNum(fin.currentRatio?.raw),
            shortFloat:     safeNum(stats.shortPercentOfFloat?.raw),
            closes:         closes.slice(-60),
        });

    } catch (err) {
        res.status(500).json({ ok: false, ticker, error: err.message });
    }
});

app.get('/api/sentiment/:ticker', async (req, res) => {
    const ticker = req.params.ticker.toUpperCase().trim();
    try {
        const r = await httpsGet(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`, {
            'User-Agent': UA,
            'Accept':     'application/json',
        });
        if (r.status !== 200) throw new Error(`StockTwits HTTP ${r.status}`);
        const json    = JSON.parse(r.body);
        const msgs    = json.messages ?? [];
        const tagged  = msgs.filter(m => m.entities?.sentiment?.basic);
        const bull    = tagged.filter(m => m.entities.sentiment.basic === 'Bullish').length;
        const bear    = tagged.filter(m => m.entities.sentiment.basic === 'Bearish').length;
        const bullPct = tagged.length > 0 ? Math.round((bull / tagged.length) * 100) : null;
        const recent  = tagged.slice(0, 8).map(m => ({
            body:      m.body.replace(/https?:\/\/\S+/g, '').trim().slice(0, 140),
            sentiment: m.entities.sentiment.basic,
            time:      m.created_at,
            user:      m.user?.username ?? '?',
        }));
        res.json({ ok: true, ticker, social: { bull, bear, total: msgs.length, tagged: tagged.length, bullPct }, recent });
    } catch (err) {
        res.status(500).json({ ok: false, ticker, error: err.message });
    }
});

app.get('/api/news/:ticker', async (req, res) => {
    const ticker = req.params.ticker.toUpperCase().trim();
    try {
        const url  = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=10&enableFuzzyQuery=false`;
        const json = await yfFetch(url);
        const raw  = json.news ?? [];
        const news = raw.map(n => ({
            title:     n.title,
            publisher: n.publisher,
            link:      n.link,
            time:      n.providerPublishTime,
            thumbnail: n.thumbnail?.resolutions?.[0]?.url ?? null,
        }));
        res.json({ ok: true, ticker, news });
    } catch (err) {
        res.status(500).json({ ok: false, ticker, error: err.message });
    }
});

// ──────────────────────────────────────────────
// TRADINGVIEW SCREENER ENDPOINT
// ──────────────────────────────────────────────
app.get('/api/tv/:ticker', async (req, res) => {
    const ticker = req.params.ticker.toUpperCase().trim();
    const columns = [
        'Recommend.All', 'Recommend.MA', 'Recommend.Other',
        'RSI', 'Stoch.K', 'Stoch.D',
        'ADX', 'ADX+DI', 'ADX-DI',
        'BB.upper', 'BB.lower', 'BB.basis',
        'EMA20', 'EMA50', 'EMA200',
        'ATR', 'OBV',
        'Pivot.M.Classic.Middle',
        'Pivot.M.Classic.R1', 'Pivot.M.Classic.R2', 'Pivot.M.Classic.R3',
        'Pivot.M.Classic.S1', 'Pivot.M.Classic.S2', 'Pivot.M.Classic.S3',
        'close',
    ];
    try {
        const payload = {
            filter: [{ left: 'name', operation: 'equal', right: ticker }],
            columns,
            markets: ['america'],
            sort:    { sortBy: 'name', sortOrder: 'asc' },
            range:   [0, 1],
        };
        const r = await httpsPost(
            'https://scanner.tradingview.com/america/scan',
            payload,
            {
                'User-Agent': UA,
                'Accept':     'application/json',
                'Origin':     'https://www.tradingview.com',
                'Referer':    'https://www.tradingview.com/',
            }
        );
        if (r.status !== 200) throw new Error(`TradingView HTTP ${r.status}`);
        const json = JSON.parse(r.body);
        const row  = json.data?.[0]?.d;
        if (!row) throw new Error('Ticker not found on TradingView');

        const get = col => { const i = columns.indexOf(col); return i >= 0 ? row[i] : null; };

        const recAll = get('Recommend.All');
        let tvSignal;
        if (recAll == null)       tvSignal = 'N/A';
        else if (recAll >= 0.5)   tvSignal = 'STRONG BUY';
        else if (recAll >= 0.1)   tvSignal = 'BUY';
        else if (recAll > -0.1)   tvSignal = 'NEUTRAL';
        else if (recAll > -0.5)   tvSignal = 'SELL';
        else                      tvSignal = 'STRONG SELL';

        const adxVal = get('ADX');
        let trendStrength;
        if (adxVal == null)      trendStrength = 'N/A';
        else if (adxVal < 20)   trendStrength = 'RANGING';
        else if (adxVal < 40)   trendStrength = 'TRENDING';
        else                    trendStrength = 'STRONG TREND';

        const k = get('Stoch.K'), d = get('Stoch.D');
        let stochSignal;
        if (k == null)                stochSignal = 'N/A';
        else if (k < 20)              stochSignal = 'OVERSOLD';
        else if (k > 80)              stochSignal = 'OVERBOUGHT';
        else if (d != null && k > d)  stochSignal = 'BULLISH';
        else                          stochSignal = 'BEARISH';

        res.json({
            ok: true,
            ticker,
            tvSignal,
            recAll,
            recMA:         get('Recommend.MA'),
            recOscillator: get('Recommend.Other'),
            stoch: { k, d, signal: stochSignal },
            adx:   { value: adxVal, plusDI: get('ADX+DI'), minusDI: get('ADX-DI'), strength: trendStrength },
            bb:    { upper: get('BB.upper'), lower: get('BB.lower'), basis: get('BB.basis') },
            ema:   { ema20: get('EMA20'), ema50: get('EMA50'), ema200: get('EMA200') },
            atr:   get('ATR'),
            obv:   get('OBV'),
            support: {
                pivot: get('Pivot.M.Classic.Middle'),
                r1:    get('Pivot.M.Classic.R1'),
                r2:    get('Pivot.M.Classic.R2'),
                r3:    get('Pivot.M.Classic.R3'),
                s1:    get('Pivot.M.Classic.S1'),
                s2:    get('Pivot.M.Classic.S2'),
                s3:    get('Pivot.M.Classic.S3'),
            },
            price: get('close'),
        });
    } catch (err) {
        res.status(500).json({ ok: false, ticker, error: err.message });
    }
});

// ──────────────────────────────────────────────
// MARKET SCANNER (TradingView screener)
// ──────────────────────────────────────────────
const SCAN_PROFILES = {
    momentum: {
        label: 'Momentum',
        filter: [
            { left: 'volume', operation: 'greater', right: 500000 },
            { left: 'market_cap_basic', operation: 'greater', right: 1e9 },
            { left: 'change', operation: 'greater', right: 3 },
            { left: 'RSI', operation: 'less', right: 75 },
            { left: 'RSI', operation: 'greater', right: 40 },
        ],
        sort: { sortBy: 'change', sortOrder: 'desc' },
    },
    oversold: {
        label: 'Oversold Bounce',
        filter: [
            { left: 'market_cap_basic', operation: 'greater', right: 2e9 },
            { left: 'RSI', operation: 'less', right: 35 },
            { left: 'volume', operation: 'greater', right: 300000 },
            { left: 'Recommend.All', operation: 'greater', right: -0.3 },
        ],
        sort: { sortBy: 'RSI', sortOrder: 'asc' },
    },
    breakout: {
        label: 'Volume Breakout',
        filter: [
            { left: 'market_cap_basic', operation: 'greater', right: 1e9 },
            { left: 'relative_volume_10d_calc', operation: 'greater', right: 2.0 },
            { left: 'change', operation: 'greater', right: 2 },
            { left: 'volume', operation: 'greater', right: 1000000 },
        ],
        sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
    },
    value: {
        label: 'Value Picks',
        filter: [
            { left: 'market_cap_basic', operation: 'greater', right: 5e9 },
            { left: 'price_earnings_ttm', operation: 'less', right: 20 },
            { left: 'price_earnings_ttm', operation: 'greater', right: 0 },
            { left: 'Recommend.All', operation: 'greater', right: 0.1 },
            { left: 'return_on_equity', operation: 'greater', right: 10 },
        ],
        sort: { sortBy: 'Recommend.All', sortOrder: 'desc' },
    },
    tvpicks: {
        label: 'TV Strong Buy',
        filter: [
            { left: 'market_cap_basic', operation: 'greater', right: 2e9 },
            { left: 'Recommend.All', operation: 'greater', right: 0.5 },
            { left: 'volume', operation: 'greater', right: 500000 },
            { left: 'change', operation: 'greater', right: 0 },
        ],
        sort: { sortBy: 'Recommend.All', sortOrder: 'desc' },
    },
    golden_cross: {
        label: 'Golden Cross',
        filter: [
            { left: 'market_cap_basic', operation: 'greater', right: 1e9 },
            { left: 'SMA50', operation: 'greater', right: 'SMA200' },
            { left: 'RSI', operation: 'less', right: 65 },
            { left: 'RSI', operation: 'greater', right: 30 },
            { left: 'Recommend.All', operation: 'greater', right: 0.2 },
            { left: 'volume', operation: 'greater', right: 500000 },
        ],
        sort: { sortBy: 'change', sortOrder: 'desc' },
    },
};

app.get('/api/scanner/:profile', async (req, res) => {
    const profile = SCAN_PROFILES[req.params.profile];
    if (!profile) return res.status(400).json({ ok: false, error: 'Unknown profile' });
    const limit = Math.min(parseInt(req.query.limit) || 15, 30);

    const columns = [
        'name', 'description', 'close', 'change', 'change_abs',
        'volume', 'relative_volume_10d_calc', 'market_cap_basic',
        'RSI', 'Recommend.All', 'Stoch.K',
        'ADX', 'ADX+DI', 'ADX-DI',
        'SMA50', 'SMA200',
        'price_earnings_ttm', 'return_on_equity',
        'earnings_per_share_basic_ttm',
    ];

    try {
        const payload = {
            filter:  profile.filter,
            columns,
            markets: ['america'],
            sort:    profile.sort,
            range:   [0, limit],
            options: { lang: 'en' },
        };
        const r = await httpsPost(
            'https://scanner.tradingview.com/america/scan',
            payload,
            { 'User-Agent': UA, 'Accept': 'application/json', 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' }
        );
        if (r.status !== 200) throw new Error(`TradingView HTTP ${r.status}`);
        const json = JSON.parse(r.body);

        const stocks = (json.data ?? []).map(item => {
            const d = item.d;
            const get = i => d[i] ?? null;
            return {
                ticker: get(0), company: get(1), price: get(2), changePct: get(3),
                changeAbs: get(4), volume: get(5), relVolume: get(6), marketCap: get(7),
                rsi: get(8), tvRec: get(9), stochK: get(10), adx: get(11),
                plusDI: get(12), minusDI: get(13), sma50: get(14), sma200: get(15),
                pe: get(16), roe: get(17), eps: get(18),
            };
        });

        res.json({ ok: true, profile: req.params.profile, label: profile.label, count: stocks.length, stocks });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ──────────────────────────────────────────────
// POLITICAL / MARKET-MOVING NEWS
// ──────────────────────────────────────────────
const POLITICAL_QUERIES = {
    trump:   'Trump tariff trade market stocks',
    fed:     'Federal Reserve interest rate decision',
    economy: 'US economy GDP jobs inflation market',
    china:   'China trade war tariff sanctions market',
    all:     'Trump tariff Federal Reserve economy market stocks trade policy',
};

app.get('/api/political-news/:topic', async (req, res) => {
    const topic = req.params.topic.toLowerCase();
    const query = POLITICAL_QUERIES[topic] ?? POLITICAL_QUERIES.all;
    try {
        const url  = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=20&enableFuzzyQuery=true`;
        const json = await yfFetch(url);
        const raw  = json.news ?? [];
        const news = raw.map(n => ({
            title:     n.title,
            publisher: n.publisher,
            link:      n.link,
            time:      n.providerPublishTime,
            thumbnail: n.thumbnail?.resolutions?.[0]?.url ?? null,
        }));
        res.json({ ok: true, topic, count: news.length, news });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ──────────────────────────────────────────────
// WATCHLISTS (Supabase)
// ──────────────────────────────────────────────
app.get('/api/watchlists', async (req, res) => {
    const { data, error } = await supabase
        .from('watchlists').select('*').order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, watchlists: data });
});

app.post('/api/watchlists', async (req, res) => {
    const { name, tickers } = req.body;
    if (!name || !Array.isArray(tickers)) return res.status(400).json({ ok: false, error: 'name and tickers[] required' });
    const { data, error } = await supabase
        .from('watchlists').insert({ name, tickers }).select().single();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, watchlist: data });
});

app.put('/api/watchlists/:id', async (req, res) => {
    const { name, tickers } = req.body;
    const update = { updated_at: new Date().toISOString() };
    if (name) update.name = name;
    if (Array.isArray(tickers)) update.tickers = tickers;
    const { data, error } = await supabase
        .from('watchlists').update(update).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, watchlist: data });
});

app.delete('/api/watchlists/:id', async (req, res) => {
    const { error } = await supabase.from('watchlists').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true });
});

// ──────────────────────────────────────────────
// SNAPSHOTS
// ──────────────────────────────────────────────
app.post('/api/snapshots', async (req, res) => {
    const { snapshots } = req.body;
    if (!Array.isArray(snapshots)) return res.status(400).json({ ok: false, error: 'snapshots[] required' });
    const { error } = await supabase.from('price_snapshots').insert(snapshots);
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, count: snapshots.length });
});

app.get('/api/snapshots/:ticker', async (req, res) => {
    const ticker = req.params.ticker.toUpperCase().trim();
    const { data, error } = await supabase
        .from('price_snapshots').select('*')
        .eq('ticker', ticker).order('captured_at', { ascending: false }).limit(30);
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, ticker, snapshots: data });
});

app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString(), supabase: !!supabase }));

export default app;
