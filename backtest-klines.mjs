#!/usr/bin/env node
// Uso: node backtest-klines.mjs [--coin BTC|ETH|SOL|ALL] [--days 90] [--minute 5 | --minute 3,5,8] [--threshold 0.15]
//
// Descarrega klines de 1 min da Binance (público, sem chave) e, para cada janela de 15 min alinhada ao UTC, mede:
//   1) P(fechar >= abertura) em função do deslocamento da vela ao minuto M (em pontos-base e em z)
//   2) se a TENDÊNCIA das velas anteriores acrescenta informação além desse deslocamento
//
// Atenção: o resultado é o da Binance (proxy). O mercado resolve pela Chainlink, por isso perto de 0 bps
// os números são só indicativos. NÃO envia ordens. Precisa de rede e de Node 18+.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

// ───────────── argumentos ─────────────
const args = process.argv.slice(2);
const opt = { coin: 'BTC', days: 90, minutes: [5], threshold: 0.15 };
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--coin') opt.coin = String(args[++i]).toUpperCase();
    else if (a === '--days') opt.days = Number(args[++i]);
    else if (a === '--minute') opt.minutes = String(args[++i]).split(',').map(Number);
    else if (a === '--threshold') opt.threshold = Number(args[++i]);
}
const SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
const coins = opt.coin === 'ALL' ? Object.keys(SYMBOL) : [opt.coin];
let M = opt.minutes[0]; // minuto em análise (muda no ciclo principal)
if (opt.minutes.some((m) => !(m >= 1 && m <= 14))) {
    console.log('--minute tem de estar entre 1 e 14 (ex.: --minute 3,5,8)');
    process.exit(1);
}
const WIN = 15 * 60_000;

// ───────────── utilitários ─────────────
const f = (x, d = 3) => (x === null || x === undefined || !isFinite(x) ? '-' : Number(x).toFixed(d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────── download com cache ─────────────
async function loadKlines(symbol, days) {
    mkdirSync('cache', { recursive: true });
    const endMs = Math.floor(Date.now() / 60_000) * 60_000;
    const startMs = endMs - days * 86_400_000;
    const cacheFile = `cache/klines-${symbol}-1m-${days}d-${new Date(endMs).toISOString().slice(0, 10)}.json`;
    if (existsSync(cacheFile)) {
        console.log(`  (cache: ${cacheFile})`);
        return JSON.parse(readFileSync(cacheFile, 'utf8'));
    }

    const rows = []; // [openTime, open, close]
    let t = startMs;
    let reqs = 0;
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
                if (attempt >= 3) throw new Error(`falha a obter klines (${e.message}). Sem acesso à Binance a partir daqui?`);
                await sleep(1000 * (attempt + 1));
            }
        }
        if (!Array.isArray(k) || !k.length) break;
        for (const x of k) rows.push([Number(x[0]), Number(x[1]), Number(x[4])]);
        t = Number(k[k.length - 1][0]) + 60_000;
        reqs++;
        if (reqs % 20 === 0) process.stdout.write(`  ${symbol}: ${rows.length} klines...\r`);
        if (k.length < 1000) break;
        await sleep(80);
    }
    process.stdout.write('\n');
    writeFileSync(cacheFile, JSON.stringify(rows));
    return rows;
}

// ───────────── construção das janelas ─────────────
function buildWindows(rows) {
    const open = new Map();
    const close = new Map();
    for (const [t, o, c] of rows) {
        open.set(t, o);
        close.set(t, c);
    }
    const first = Math.ceil(rows[0][0] / WIN) * WIN;
    const last = Math.floor(rows[rows.length - 1][0] / WIN) * WIN - WIN;

    const winClose = (ws) => close.get(ws + 14 * 60_000);
    const out = [];

    for (let ws = first + 12 * WIN; ws <= last; ws += WIN) {
        // janela completa?
        let ok = true;
        for (let k = 0; k < 15; k++) if (!open.has(ws + k * 60_000)) { ok = false; break; }
        if (!ok) continue;

        const open15 = open.get(ws);
        const close15 = winClose(ws);
        const tM = ws + (M - 1) * 60_000;
        const priceM = close.get(tM);

        // σ por minuto: 60 retornos de 1 min anteriores ao minuto M
        const rets = [];
        for (let k = 0; k < 60; k++) {
            const c1 = close.get(tM - k * 60_000);
            const c0 = close.get(tM - (k + 1) * 60_000);
            if (c1 && c0) rets.push(Math.log(c1 / c0));
        }
        if (rets.length < 40) continue;
        const sd1m = Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length);

        // tendência: média dos últimos 5 fechos de 15m COMPLETOS vs. dos 5 anteriores
        const prev = [];
        for (let j = 1; j <= 10; j++) prev.push(winClose(ws - j * WIN));
        if (prev.some((x) => !x)) continue;
        const recent = mean(prev.slice(0, 5));
        const older = mean(prev.slice(5, 10));
        const trendPct = ((recent - older) / older) * 100;

        const disp = (priceM - open15) / open15; // fração
        const z = disp / (sd1m * Math.sqrt(15 - M));

        out.push({ ws, up: close15 >= open15, dispBps: disp * 1e4, z, trendPct });
    }
    return out;
}

// ───────────── tabelas ─────────────
const ci = (p, n) => (n > 0 ? 1.96 * Math.sqrt((p * (1 - p)) / n) : NaN);

function bucketTable(title, wins, key, edges, labelFn, theory) {
    console.log(title);
    console.log(`   ${'faixa'.padEnd(14)} |      n | P(Up) real (±IC95) ${theory ? '| Φ(z) teórico ' : ''}`);
    for (let i = 0; i < edges.length - 1; i++) {
        const s = wins.filter((w) => w[key] >= edges[i] && w[key] < edges[i + 1]);
        if (s.length < 30) continue;
        const p = s.filter((w) => w.up).length / s.length;
        const th = theory ? ` | ${f(normCdf(mean(s.map((w) => w.z))), 3)}` : '';
        console.log(`   ${labelFn(edges[i], edges[i + 1]).padEnd(14)} | ${String(s.length).padStart(6)} | ${f(p, 3)} (±${f(ci(p, s.length), 3)})${th}`);
    }
    console.log('');
}

function analyze(coin, wins) {
    const ups = wins.filter((w) => w.up).length;
    console.log(`\n══════ ${coin} | ${wins.length} janelas | P(Up) base=${f(ups / wins.length, 3)} | minuto ${M} (faltam ${15 - M} min) ══════\n`);

    const B = [-1e9, -15, -10, -5, -2, 0, 2, 5, 10, 15, 1e9];
    const lab = (a, b) => (a <= -1e8 ? `<${b}` : b >= 1e8 ? `>=${a}` : `${a}..${b}`) + ' bps';
    bucketTable(`1) P(Up) por deslocamento da vela face à abertura (ao minuto ${M})`, wins, 'dispBps', B, lab, false);

    const Z = [-1e9, -2, -1, -0.5, 0, 0.5, 1, 2, 1e9];
    const labZ = (a, b) => (a <= -1e8 ? `z<${b}` : b >= 1e8 ? `z>=${a}` : `z ${a}..${b}`);
    bucketTable('2) P(Up) por z (deslocamento / desvio esperado): compara com Φ(z), o passeio aleatório', wins, 'z', Z, labZ, true);

    // 3) a tendência acrescenta informação, dado o deslocamento?
    console.log(`3) A TENDÊNCIA acrescenta algo? P(Up) por deslocamento, separando por tendência (limiar ${opt.threshold}%)`);
    console.log(`   ${'deslocamento'.padEnd(14)} | tend. ALTA (n, P) | tend. BAIXA (n, P) | neutra (n, P) | alta − baixa`);
    const D = [-5, -2, 0, 2, 5, 10];
    for (let i = 0; i < D.length - 1; i++) {
        const s = wins.filter((w) => w.dispBps >= D[i] && w.dispBps < D[i + 1]);
        const g = (fn) => {
            const t = s.filter(fn);
            return { n: t.length, p: t.length ? t.filter((w) => w.up).length / t.length : NaN };
        };
        const hi = g((w) => w.trendPct > opt.threshold);
        const lo = g((w) => w.trendPct < -opt.threshold);
        const ne = g((w) => Math.abs(w.trendPct) <= opt.threshold);
        const diff = hi.n >= 30 && lo.n >= 30 ? hi.p - lo.p : NaN;
        const se = hi.n >= 30 && lo.n >= 30 ? 1.96 * Math.sqrt((hi.p * (1 - hi.p)) / hi.n + (lo.p * (1 - lo.p)) / lo.n) : NaN;
        console.log(
            `   ${(`${D[i]}..${D[i + 1]} bps`).padEnd(14)} | ${String(hi.n).padStart(5)} ${f(hi.p, 3)}    | ${String(lo.n).padStart(5)} ${f(lo.p, 3)}     | ${String(ne.n).padStart(5)} ${f(ne.p, 3)} | ${isFinite(diff) ? (diff >= 0 ? '+' : '') + f(diff * 100, 1) + ' pts (±' + f(se * 100, 1) + ')' : '-'}`
        );
    }
    console.log('   → se "alta − baixa" fica perto de 0 (dentro do ±), a tendência não acrescenta nada ao deslocamento da vela atual.\n');
}

// ───────────── main ─────────────
console.log(`A descarregar ${opt.days} dias de klines de 1 min (${coins.join(', ')})...`);
const data = {};
for (const c of coins) {
    const rows = await loadKlines(SYMBOL[c], opt.days);
    if (rows.length < 5000) {
        console.log(`  ${c}: poucos dados (${rows.length}).`);
        continue;
    }
    data[c] = rows;
}

for (const m of opt.minutes) {
    M = m;
    const all = [];
    for (const c of Object.keys(data)) {
        const wins = buildWindows(data[c]);
        all.push(...wins);
        analyze(c, wins);
    }
    if (Object.keys(data).length > 1 && all.length) analyze('TODAS', all);
}

console.log('Como usar isto: compara a coluna "P(Up) real" com o preço que o mercado cobra pelo token.');
console.log('Exemplo hipotético (não é um resultado): se P(Up) real fosse 0.55 numa faixa e o ask 0.50, o edge bruto seria 5 pts, ANTES de fees, spread e erro de fonte.');
console.log('Cuidado: dados da Binance (USDT). Perto de 0 bps, o resultado oficial (Chainlink) pode diferir.');
