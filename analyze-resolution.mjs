#!/usr/bin/env node
// Uso: node analyze-resolution.mjs [--coin BTC] [--windows 300] [--kdays 90]
//
// Descobre QUAL É A REGRA DE RESOLUÇÃO real dos mercados Up/Down de 15 min, comparando o resultado OFICIAL
// (API Gamma, outcomePrices) com várias regras candidatas calculadas sobre klines de 1 min da Binance:
//   A: close da janela >= open da janela                       (o que o backtest e os modelos usaram até agora)
//   B: média (TWAP) dos 15 min >= open                          (leitura literal do texto das regras)
//   C: TWAP de ~60 s no fim >= open
//   D: TWAP de ~60 s no fim >= TWAP de ~60 s imediatamente antes do início
//   E: TWAP de ~60 s no fim >= TWAP de ~60 s do 1.º minuto
// A regra que mais vezes coincidir com o resultado oficial é a que o mercado usa (ou a que mais se aproxima).
//
// Aproximações: TWAP de 1 minuto ≈ (open+close)/2 do minuto, e a Binance (USDT) não é a Chainlink. Por isso, mesmo a regra
// certa não chega a 100%. O que importa é a DIFERENÇA entre regras. Precisa de rede e Node 18+. NÃO envia ordens.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const args = process.argv.slice(2);
const opt = { coin: 'BTC', windows: 300, kdays: 90 };
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--coin') opt.coin = String(args[++i]).toUpperCase();
    else if (args[i] === '--windows') opt.windows = Number(args[++i]);
    else if (args[i] === '--kdays') opt.kdays = Number(args[++i]);
}
const SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
if (!SYMBOL[opt.coin]) { console.log('--coin tem de ser BTC, ETH ou SOL'); process.exit(1); }
const WIN = 15 * 60_000, MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (x, d = 1) => (x === null || x === undefined || !isFinite(x) ? '-' : Number(x).toFixed(d));

// ───────────── klines (mesma cache do backtest-klines.mjs) ─────────────
async function loadKlines(symbol, days) {
    mkdirSync('cache', { recursive: true });
    const endMs = Math.floor(Date.now() / MIN) * MIN;
    const startMs = endMs - days * 86_400_000;
    const cacheFile = `cache/klines-${symbol}-1m-${days}d-${new Date(endMs).toISOString().slice(0, 10)}.json`;
    if (existsSync(cacheFile)) { console.log(`(cache de klines: ${cacheFile})`); return JSON.parse(readFileSync(cacheFile, 'utf8')); }
    const rows = [];
    let t = startMs, reqs = 0;
    while (t < endMs) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${t}&limit=1000`;
        let k;
        for (let attempt = 0; ; attempt++) {
            try {
                const r = await fetch(url);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                k = await r.json();
                break;
            } catch (e) {
                if (attempt >= 3) throw new Error(`falha a obter klines (${e.message})`);
                await sleep(1000 * (attempt + 1));
            }
        }
        if (!Array.isArray(k) || !k.length) break;
        for (const x of k) rows.push([Number(x[0]), Number(x[1]), Number(x[4])]);
        t = Number(k[k.length - 1][0]) + MIN;
        if (++reqs % 20 === 0) process.stdout.write(`  ${symbol}: ${rows.length} klines...\r`);
        if (k.length < 1000) break;
        await sleep(80);
    }
    process.stdout.write('\n');
    writeFileSync(cacheFile, JSON.stringify(rows));
    return rows;
}

// ───────────── resultado oficial (Gamma) ─────────────
let ruleText = null;
async function officialOutcome(coin, wsMs) {
    const slug = `${coin.toLowerCase()}-updown-15m-${wsMs / 1000}`;
    const url = `https://gamma-api.polymarket.com/markets?slug=${slug}&closed=true`;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 10_000);
            const r = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
            if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
            if (!r.ok) return { error: `HTTP ${r.status}` };
            const j = await r.json();
            const m = Array.isArray(j) ? j[0] : j;
            if (!m) return { error: 'sem mercado' };
            if (!ruleText && m.description) ruleText = String(m.description);
            const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
            const prices = (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices)?.map(Number);
            if (!outcomes || !prices) return { error: 'sem outcomes' };
            const iUp = outcomes.findIndex((x) => /^(up|yes)$/i.test(String(x)));
            if (iUp < 0) return { error: 'sem outcome Up' };
            const pUp = prices[iUp], pOther = prices[1 - iUp];
            if (pUp >= 0.99 && pOther <= 0.01) return { upWon: true };
            if (pUp <= 0.01 && pOther >= 0.99) return { upWon: false };
            return { error: 'não resolvido' };
        } catch (e) {
            await sleep(1000 * (attempt + 1));
        }
    }
    return { error: 'falha de rede' };
}

// ───────────── regras candidatas ─────────────
function candidateRules(open, close, ws) {
    const k = (i) => ({ o: open.get(ws + i * MIN), c: close.get(ws + i * MIN) });
    for (let i = -1; i <= 14; i++) {
        const x = k(i);
        if (!x.o || !x.c) return null;
    }
    const mid = (i) => (k(i).o + k(i).c) / 2;
    const open0 = k(0).o;
    let sum = 0;
    for (let i = 0; i <= 14; i++) sum += mid(i);
    const twapAll = sum / 15, twapEnd = mid(14);
    return {
        rules: {
            'A: close da janela >= open': k(14).c >= open0,
            'B: TWAP dos 15 min >= open': twapAll >= open0,
            'C: TWAP 60s no fim >= open': twapEnd >= open0,
            'D: TWAP 60s no fim >= TWAP 60s antes do início': twapEnd >= mid(-1),
            'E: TWAP 60s no fim >= TWAP 60s do 1.º minuto': twapEnd >= mid(0)
        },
        dispBps: ((k(14).c - open0) / open0) * 1e4
    };
}

// ───────────── main ─────────────
console.log(`A carregar klines de ${opt.coin} (${opt.kdays} dias)...`);
const rows = await loadKlines(SYMBOL[opt.coin], opt.kdays);
const open = new Map(), close = new Map();
for (const [t, o, c] of rows) { open.set(t, o); close.set(t, c); }

const lastWs = Math.floor((Date.now() - 45 * MIN) / WIN) * WIN;
const wsList = [];
for (let i = 0; i < opt.windows; i++) wsList.push(lastWs - i * WIN);

console.log(`A obter o resultado oficial de ${wsList.length} janelas à API Gamma (4 em paralelo)...`);
const queue = [...wsList];
const official = new Map();
let done = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
        const ws = queue.shift();
        official.set(ws, await officialOutcome(opt.coin, ws));
        if (++done % 50 === 0 || done === wsList.length) console.log(`  ... ${done}/${wsList.length}`);
        await sleep(60);
    }
}));

const errs = new Map();
const samples = [];
for (const ws of wsList) {
    const o = official.get(ws);
    if (o.error) { errs.set(o.error, (errs.get(o.error) ?? 0) + 1); continue; }
    const c = candidateRules(open, close, ws);
    if (!c) { errs.set('sem klines', (errs.get('sem klines') ?? 0) + 1); continue; }
    samples.push({ ws, upWon: o.upWon, ...c });
}
console.log(`\nJanelas comparáveis: ${samples.length} de ${wsList.length}` + (errs.size ? ` | descartadas: ${[...errs.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}` : ''));
if (!samples.length) process.exit(0);

if (ruleText) console.log(`\nTexto das regras (1.º mercado):\n${ruleText.slice(0, 700)}\n`);
console.log(`Resultado oficial: Up em ${f((samples.filter((s) => s.upWon).length / samples.length) * 100)}% das janelas\n`);

const names = Object.keys(samples[0].rules);
const stat = names.map((n) => {
    const ok = samples.filter((s) => s.rules[n] === s.upWon).length;
    const gray = samples.filter((s) => Math.abs(s.dispBps) < 1.5);
    const okGray = gray.filter((s) => s.rules[n] === s.upWon).length;
    return { n, agree: ok / samples.length, ok, okGray, nGray: gray.length };
}).sort((a, b) => b.agree - a.agree);

console.log('Concordância de cada regra candidata com o resultado OFICIAL:');
console.log('   regra                                             | concordância | zona cinzenta (|close−open|<1.5 bps)');
for (const s of stat) {
    console.log(`   ${s.n.padEnd(49)} | ${f(s.agree * 100).padStart(6)}%      | ${s.okGray}/${s.nGray}`);
}

const best = stat[0], second = stat[1];
const diff = (best.agree - second.agree) * 100;
const se = Math.sqrt((best.agree * (1 - best.agree) + second.agree * (1 - second.agree)) / samples.length) * 100;
console.log(`\nMelhor: ${best.n.split(':')[0]} (${f(best.agree * 100)}%). Vantagem sobre a 2.ª: ${f(diff)} pts (erro-padrão ~${f(se)}).`);
console.log('Leitura:');
console.log(' - uma regra claramente à frente das outras (vários pontos acima do erro) é a que o mercado usa, ou a mais próxima;');
console.log(' - se A ficar bem abaixo de uma das outras, os modelos e backtests que assumem "close >= open" estão a usar a regra errada;');
console.log(' - nenhuma chega a 100% porque a Binance não é a Chainlink e o TWAP de 1 min aqui é aproximado: compara regras, não valores absolutos.');
