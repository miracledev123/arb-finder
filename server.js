const express       = require('express');
const cors          = require('cors');
const { Pool }      = require('pg');
const chromium      = require('@sparticuz/chromium');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Residential proxy config (DataImpulse) ────────────────────────────────────
const PROXY_HOST = process.env.PROXY_HOST || 'gw.dataimpulse.com';
const PROXY_PORT = process.env.PROXY_PORT || '823';
const PROXY_USER = process.env.PROXY_USER || ''; // e.g. 39f93bc73b4cfb5caa29__cr.ng
const PROXY_PASS = process.env.PROXY_PASS || '';
const PROXY_ENABLED = !!(PROXY_USER && PROXY_PASS);

// ── Browser launch ────────────────────────────────────────────────────────────
// @sparticuz/chromium bundles a Chrome binary specifically packaged to survive
// ephemeral/serverless filesystems like Render's — no system install needed.
// puppeteer-extra + stealth mask automation fingerprints (webdriver flag, etc).
// Proxy routes traffic through a residential Nigerian IP to avoid datacenter blocks.
async function launchBrowser() {
  const executablePath = await chromium.executablePath();
  console.log('Chrome executable resolved to:', executablePath);
  console.log('Proxy enabled:', PROXY_ENABLED);

  const args = [...chromium.args];
  if (PROXY_ENABLED) {
    args.push(`--proxy-server=${PROXY_HOST}:${PROXY_PORT}`);
  }

  return puppeteerExtra.launch({
    executablePath,
    headless: chromium.headless,
    args,
    defaultViewport: chromium.defaultViewport,
  });
}

// Call this right after browser.newPage() whenever a proxy is enabled —
// residential proxies with username/password need explicit authentication.
async function authenticatePage(page) {
  if (PROXY_ENABLED) {
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
  }
}

// ── Intercept XHR/fetch from SportyBet ───────────────────────────────────────
async function fetchSportyBet(browser) {
  const page = await browser.newPage();
  await authenticatePage(page);
  const collected = [];

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
  );

  // Intercept all API responses SportyBet makes internally
  page.on('response', async (response) => {
    const url = response.url();
    if (
      url.includes('sportybet.com/api') &&
      (url.includes('factsCenter') || url.includes('sports') || url.includes('events'))
    ) {
      try {
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const json = await response.json();
        collected.push({ url, data: json });
      } catch(e) {}
    }
  });

  try {
    // Load the main page — this triggers all the internal API calls
    await page.goto('https://www.sportybet.com/ng/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Give it extra time to load more sport tabs
    await new Promise(r => setTimeout(r, 5000));

    // Click through sport tabs to trigger more API calls
    const sportTabs = await page.$$('[data-sport], .sport-tab, .nav-sport');
    for (const tab of sportTabs.slice(0, 6)) {
      try {
        await tab.click();
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {}
    }

  } catch(e) {
    console.error('SportyBet page error:', e.message);
  }

  await page.close();

  // Parse all collected API responses into normalized events
  const events = [];
  for (const { data } of collected) {
    const tournaments = data?.data?.tournamentEvents || data?.data || [];
    if (!Array.isArray(tournaments)) continue;
    for (const t of tournaments) {
      const sport = t.sport?.name || t.sportName || 'Football';
      for (const ev of (t.events || [])) {
        events.push({ ...ev, _sport: sport });
      }
    }
  }

  console.log(`SportyBet: intercepted ${collected.length} API calls, got ${events.length} events`);
  return events;
}

// ── Intercept XHR/fetch from Nairabet ────────────────────────────────────────
async function fetchNairabet(browser) {
  const page = await browser.newPage();
  await authenticatePage(page);
  const collected = [];

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
  );

  page.on('response', async (response) => {
    const url = response.url();
    if (
      url.includes('nairabet.com') &&
      (url.includes('/api/') || url.includes('/ms/') || url.includes('events') || url.includes('odds'))
    ) {
      try {
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const json = await response.json();
        collected.push({ url, data: json });
      } catch(e) {}
    }
  });

  try {
    await page.goto('https://www.nairabet.com/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await new Promise(r => setTimeout(r, 5000));

    // Click sport tabs
    const sportTabs = await page.$$('[data-sport], .sport-item, .sports-list li, .sports-nav a');
    for (const tab of sportTabs.slice(0, 6)) {
      try {
        await tab.click();
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {}
    }

  } catch(e) {
    console.error('Nairabet page error:', e.message);
  }

  await page.close();

  // Parse collected responses
  const events = [];
  for (const { data } of collected) {
    const evList = data?.data || data?.events || data?.result || (Array.isArray(data) ? data : []);
    if (Array.isArray(evList)) events.push(...evList);
  }

  console.log(`Nairabet: intercepted ${collected.length} API calls, got ${events.length} events`);
  return events;
}

// ── Normalize ─────────────────────────────────────────────────────────────────
function normalizeSportybet(ev) {
  const home = ev.homeTeamName || ev.home || ev.team1 || '';
  const away = ev.awayTeamName || ev.away || ev.team2 || '';
  const name = `${home} vs ${away}`.trim();
  const kickoff = Number(ev.estimateStartTime || ev.startTime || 0);
  const markets = {};
  for (const mkt of (ev.markets || [])) {
    const mktName = mkt.name || mkt.desc || 'Unknown';
    const outcomes = {};
    for (const out of (mkt.outcomes || mkt.result || [])) {
      const oName = out.desc || out.name || '';
      const odds  = parseFloat(out.odds || out.price || 0);
      if (oName && odds > 1.01) outcomes[oName] = odds;
    }
    if (Object.keys(outcomes).length) markets[mktName] = outcomes;
  }
  return { eventName: name.toLowerCase(), displayName: name, kickoff, sport: ev._sport || 'Football', markets };
}

function normalizeNairabet(ev) {
  const home = ev.homeTeam || ev.home_team || ev.team1 || ev.home || '';
  const away = ev.awayTeam || ev.away_team || ev.team2 || ev.away || '';
  const name = `${home} vs ${away}`.trim();
  const kickoff = Number(ev.startTime || ev.start_time || ev.eventDate || ev.kickoff || 0);
  const markets = {};
  for (const mkt of (ev.markets || ev.odds || ev.betTypes || [])) {
    const mktName = mkt.name || mkt.betTypeName || mkt.type || 'Unknown';
    const outcomes = {};
    for (const out of (mkt.outcomes || mkt.selections || mkt.picks || [])) {
      const oName = out.name || out.selectionName || out.label || '';
      const odds  = parseFloat(out.odds || out.price || out.value || 0);
      if (oName && odds > 1.01) outcomes[oName] = odds;
    }
    if (Object.keys(outcomes).length) markets[mktName] = outcomes;
  }
  return { eventName: name.toLowerCase(), displayName: name, kickoff, sport: ev.sport || ev.category || 'Football', markets };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  b = b.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (a === b) return 1;
  const bg = s => { const t = new Set(); for (let i = 0; i < s.length - 1; i++) t.add(s.slice(i, i+2)); return t; };
  const aB = bg(a), bB = bg(b);
  let inter = 0;
  for (const x of aB) if (bB.has(x)) inter++;
  return (2 * inter) / (aB.size + bB.size);
}

function matchEvents(sEvs, nEvs) {
  const matched = [];
  for (const sEv of sEvs) {
    if (!sEv.eventName || sEv.eventName.replace('vs','').trim().length < 3) continue;
    for (const nEv of nEvs) {
      if (!nEv.eventName || nEv.eventName.replace('vs','').trim().length < 3) continue;
      if (similarity(sEv.eventName, nEv.eventName) < 0.75) continue;
      const sK = sEv.kickoff, nK = nEv.kickoff;
      if (sK && nK) {
        const diff = Math.abs(sK - nK);
        const diffSec = diff > 1e10 ? diff / 1000 : diff;
        if (diffSec > 10800) continue;
      }
      matched.push({ sporty: sEv, naira: nEv });
      break;
    }
  }
  return matched;
}

function detectArbs(matched, minPct = 3.0) {
  const arbs = [], seen = new Set();
  for (const { sporty, naira } of matched) {
    for (const [sMkt, sOuts] of Object.entries(sporty.markets)) {
      const nMktKey = Object.keys(naira.markets).find(k => similarity(k, sMkt) > 0.65);
      if (!nMktKey) continue;
      const nOuts = naira.markets[nMktKey];
      for (const [sOut, sOdds] of Object.entries(sOuts)) {
        for (const [nOut, nOdds] of Object.entries(nOuts)) {
          if (sOut.toLowerCase() === nOut.toLowerCase()) continue;
          const imp = (1 / sOdds) + (1 / nOdds);
          if (imp >= 1) continue;
          const margin = (1 - imp) * 100;
          if (margin < minPct) continue;
          const id = 'arb_' + stableHash([sporty.eventName, sMkt, sOut, nOut].join('||'));
          if (seen.has(id)) continue;
          seen.add(id);
          arbs.push({
            id, event_name: sporty.displayName, sport: sporty.sport,
            market_name: sMkt,
            leg1_outcome: sOut, leg1_odds: sOdds, leg1_market: sMkt,
            leg2_outcome: nOut, leg2_odds: nOdds, leg2_market: nMktKey,
            margin: parseFloat(margin.toFixed(4)),
            kickoff_ts: sporty.kickoff || Date.now()
          });
        }
      }
    }
  }
  return arbs.sort((a, b) => b.margin - a.margin);
}

// ── DB ────────────────────────────────────────────────────────────────────────
async function loadArbs({ page = 1, perPage = 20 } = {}) {
  const offset = (page - 1) * perPage;
  const [rows, countRes] = await Promise.all([
    pool.query(
      `SELECT * FROM arb_opportunities
       ORDER BY
         CASE WHEN kickoff_ts > 0 THEN DATE_TRUNC('day', TO_TIMESTAMP(kickoff_ts/1000)) ELSE NOW() END ASC,
         margin DESC
       LIMIT $1 OFFSET $2`,
      [perPage, offset]
    ),
    pool.query(`SELECT COUNT(*) FROM arb_opportunities`)
  ]);
  return { arbs: rows.rows, total: parseInt(countRes.rows[0].count) };
}

async function syncArbs(freshArbs) {
  const freshIds = freshArbs.map(a => a.id);
  const existing = await pool.query(`SELECT id, leg1_odds, leg2_odds, scan_count FROM arb_opportunities`);
  const existMap = {};
  for (const r of existing.rows) existMap[r.id] = r;

  let added = 0, updated = 0, removed = 0;

  for (const arb of freshArbs) {
    const ex = existMap[arb.id];
    if (!ex) {
      await pool.query(
        `INSERT INTO arb_opportunities
          (id,event_name,sport,market_name,
           leg1_outcome,leg1_odds,leg1_market,
           leg2_outcome,leg2_odds,leg2_market,
           margin,kickoff_ts,first_seen,last_seen,odds_changed,scan_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW(),false,1)
         ON CONFLICT (id) DO NOTHING`,
        [arb.id, arb.event_name, arb.sport, arb.market_name,
         arb.leg1_outcome, arb.leg1_odds, arb.leg1_market,
         arb.leg2_outcome, arb.leg2_odds, arb.leg2_market,
         arb.margin, arb.kickoff_ts]
      );
      added++;
    } else {
      const changed =
        Math.abs(ex.leg1_odds - arb.leg1_odds) > 0.001 ||
        Math.abs(ex.leg2_odds - arb.leg2_odds) > 0.001;
      await pool.query(
        `UPDATE arb_opportunities SET
           last_seen=NOW(), leg1_odds=$2, leg2_odds=$3,
           margin=$4, odds_changed=$5, scan_count=$6, kickoff_ts=$7
         WHERE id=$1`,
        [arb.id, arb.leg1_odds, arb.leg2_odds, arb.margin,
         changed, (ex.scan_count || 0) + 1, arb.kickoff_ts]
      );
      updated++;
    }
  }

  // Remove stale arbs
  const toRemove = existing.rows.map(r => r.id).filter(id => !freshIds.includes(id));
  if (toRemove.length) {
    await pool.query(`DELETE FROM arb_opportunities WHERE id = ANY($1)`, [toRemove]);
    removed = toRemove.length;
  }

  return { added, updated, removed };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/arbs', async (req, res) => {
  try {
    const page    = parseInt(req.query.page)    || 1;
    const perPage = parseInt(req.query.perPage) || 20;
    const result  = await loadArbs({ page, perPage });
    res.json({ success: true, ...result, page, perPage, pages: Math.ceil(result.total / perPage) });
  } catch(e) {
    console.error('Load error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── DEBUG: inspect Chrome resolution via @sparticuz/chromium ─────────────────
app.get('/debug-chrome', async (req, res) => {
  try {
    const execPath = await chromium.executablePath();
    const fs = require('fs');
    res.json({
      success: true,
      executablePath: execPath,
      exists: fs.existsSync(execPath),
      chromiumArgs: chromium.args,
      headless: chromium.headless,
      proxyEnabled: PROXY_ENABLED,
      proxyHost: PROXY_ENABLED ? PROXY_HOST : null,
      proxyUserPrefix: PROXY_ENABLED ? PROXY_USER.slice(0, 8) + '...' : null
    });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message, stack: e.stack });
  }
});

// ── DEBUG: verify the proxy is actually routing through Nigeria ──────────────
app.get('/debug-ip', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await authenticatePage(page);
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const bodyText = await page.evaluate(() => document.body.innerText);
    await browser.close();
    res.json({ success: true, proxyEnabled: PROXY_ENABLED, ipResponse: bodyText });
  } catch(e) {
    if (browser) { try { await browser.close(); } catch(_) {} }
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── DEBUG: dump raw intercepted payloads without any parsing/matching ────────
app.get('/debug-scan', async (req, res) => {
  const startTime = Date.now();
  const HARD_DEADLINE_MS = 55000; // respond no matter what by ~55s
  const timeLeft = () => HARD_DEADLINE_MS - (Date.now() - startTime);
  const elapsed  = () => ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  let browser;
  let responded = false;
  const timings = {};

  // Failsafe: if we blow past the deadline, respond with whatever we have instead of hanging
  const failsafeTimer = setTimeout(async () => {
    if (responded) return;
    responded = true;
    console.log('FAILSAFE TRIGGERED at', elapsed());
    if (browser) { try { await browser.close(); } catch(_) {} }
    res.status(200).json({
      success: false,
      timedOut: true,
      timings,
      message: 'Hit hard deadline before finishing — see timings for where it stalled.'
    });
  }, HARD_DEADLINE_MS);

  try {
    let t0 = Date.now();
    browser = await launchBrowser();
    timings.browserLaunch = elapsed();
    console.log('Browser launched at', elapsed());

    const page = await browser.newPage();
    await authenticatePage(page);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    timings.sportyPageSetup = elapsed();

    const raw = { sportybet: [], nairabet: [] };
    const diagnostics = { sportybet: {}, nairabet: {} };

    let allResponses = [];
    page.on('response', async (response) => {
      const url = response.url();
      allResponses.push({ url, status: response.status() });
      const ct  = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const json = await response.json();
        if (url.includes('sportybet.com')) raw.sportybet.push({ url, sample: json });
      } catch(e) {}
    });

    let consoleMsgs = [];
    page.on('console', msg => consoleMsgs.push(msg.text()));
    page.on('pageerror', err => consoleMsgs.push('PAGEERROR: ' + err.message));

    let sportyNavResult = 'ok';
    try {
      console.log('Starting SportyBet nav at', elapsed());
      await page.goto('https://www.sportybet.com/ng/sport/football', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 4000));
    } catch(e) { sportyNavResult = 'ERROR: ' + e.message; }
    timings.sportyNavDone = elapsed();
    console.log('SportyBet nav finished at', elapsed(), '-', sportyNavResult);

    diagnostics.sportybet = {
      navResult: sportyNavResult,
      finalUrl: page.url(),
      title: await page.title().catch(() => 'N/A'),
      totalResponses: allResponses.length,
      sampleResponseUrls: allResponses.slice(0, 20).map(r => r.status + ' ' + r.url),
      bodyTextSnippet: await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : 'NO BODY').catch(() => 'eval failed'),
      consoleErrors: consoleMsgs.slice(0, 8)
    };

    await page.close();
    allResponses = [];
    consoleMsgs = [];
    timings.sportyPageClosed = elapsed();

    // Bail early if we're already low on time — skip Nairabet, return what we have
    if (timeLeft() < 15000) {
      timings.skippedNairabet = 'not enough time left: ' + elapsed();
      await browser.close();
      clearTimeout(failsafeTimer);
      if (!responded) {
        responded = true;
        return res.json({
          success: true,
          partial: true,
          sportybet_calls_intercepted: raw.sportybet.length,
          nairabet_calls_intercepted: 0,
          sportybet_sample: raw.sportybet.slice(0,5).map(x => ({ url: x.url, sample: JSON.stringify(x.sample).slice(0,2500) })),
          nairabet_sample: [],
          diagnostics,
          timings
        });
      }
      return;
    }

    const page2 = await browser.newPage();
    await authenticatePage(page2);
    await page2.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page2.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    timings.nairaPageSetup = elapsed();

    page2.on('response', async (response) => {
      const url = response.url();
      allResponses.push({ url, status: response.status() });
      const ct  = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const json = await response.json();
        if (url.includes('nairabet.com') || url.includes('biahosted.com') || url.includes('altenar')) raw.nairabet.push({ url, sample: json });
      } catch(e) {}
    });
    page2.on('console', msg => consoleMsgs.push(msg.text()));
    page2.on('pageerror', err => consoleMsgs.push('PAGEERROR: ' + err.message));

    let nairaNavResult = 'ok';
    try {
      console.log('Starting Nairabet nav at', elapsed());
      const remainingForNaira = Math.max(8000, timeLeft() - 8000); // leave 8s buffer to respond
      await page2.goto('https://nairabet.com/sports/football', { waitUntil: 'domcontentloaded', timeout: remainingForNaira });
      await new Promise(r => setTimeout(r, Math.min(5000, Math.max(0, timeLeft() - 5000))));
    } catch(e) { nairaNavResult = 'ERROR: ' + e.message; }
    timings.nairaNavDone = elapsed();
    console.log('Nairabet nav finished at', elapsed(), '-', nairaNavResult);

    diagnostics.nairabet = {
      navResult: nairaNavResult,
      finalUrl: page2.url(),
      title: await page2.title().catch(() => 'N/A'),
      totalResponses: allResponses.length,
      sampleResponseUrls: allResponses.slice(0, 20).map(r => r.status + ' ' + r.url),
      bodyTextSnippet: await page2.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : 'NO BODY').catch(() => 'eval failed'),
      consoleErrors: consoleMsgs.slice(0, 8)
    };

    await page2.close();
    await browser.close();
    timings.allDone = elapsed();

    const trim = (arr) => arr.slice(0, 5).map(x => ({
      url: x.url,
      sample: JSON.stringify(x.sample).slice(0, 2500)
    }));

    clearTimeout(failsafeTimer);
    if (!responded) {
      responded = true;
      res.json({
        success: true,
        sportybet_calls_intercepted: raw.sportybet.length,
        nairabet_calls_intercepted: raw.nairabet.length,
        sportybet_sample: trim(raw.sportybet),
        nairabet_sample: trim(raw.nairabet),
        diagnostics,
        timings
      });
    }

  } catch(e) {
    clearTimeout(failsafeTimer);
    if (browser) { try { await browser.close(); } catch(_) {} }
    if (!responded) {
      responded = true;
      res.status(500).json({ success: false, error: e.message, timings });
    }
  }
});

app.post('/scan', async (req, res) => {
  const minMargin = parseFloat(req.query.minMargin || req.body?.minMargin || 3.0);
  let browser;
  try {
    console.log('Launching browser...');
    browser = await launchBrowser();

    console.log('Fetching SportyBet...');
    const sportyRaw = await fetchSportyBet(browser);

    console.log('Fetching Nairabet...');
    const nairaRaw  = await fetchNairabet(browser);

    await browser.close();
    browser = null;

    console.log(`Raw: Sporty=${sportyRaw.length} Naira=${nairaRaw.length}`);

    const sportyNorm = sportyRaw.map(normalizeSportybet).filter(e => e.eventName.replace('vs','').trim().length > 2);
    const nairaNorm  = nairaRaw.map(normalizeNairabet).filter(e => e.eventName.replace('vs','').trim().length > 2);
    const matched    = matchEvents(sportyNorm, nairaNorm);
    const fresh      = detectArbs(matched, minMargin);

    console.log(`Matched=${matched.length} Arbs=${fresh.length}`);

    const sync   = await syncArbs(fresh);
    const result = await loadArbs({ page: 1, perPage: 20 });

    res.json({
      success: true,
      scan: {
        sportybet_events: sportyRaw.length,
        nairabet_events:  nairaRaw.length,
        matched_pairs:    matched.length,
        arbs_found:       fresh.length,
        ...sync
      },
      ...result,
      page: 1, perPage: 20,
      pages: Math.ceil(result.total / 20)
    });

  } catch(e) {
    if (browser) { try { await browser.close(); } catch(_) {} }
    console.error('Scan error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/arbs', async (_, res) => {
  try {
    await pool.query('DELETE FROM arb_opportunities');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

const server = app.listen(PORT, () => {
  console.log(`Arb proxy v2 (Puppeteer) on port ${PORT}`);
  console.log(`DB: ${process.env.DATABASE_URL ? 'Connected' : 'WARNING: No DATABASE_URL'}`);
});

// Raise Node's own HTTP server timeout so long Puppeteer scans aren't killed early
server.timeout = 120000;       // 2 minutes
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
