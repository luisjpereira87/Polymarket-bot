#!/usr/bin/env node
// Uso: node backtest-twap.mjs [--coin BTC] [--days 30] [--minute 3,5,8,10]
//
// Backtest sob a regra de resolução confirmada (regra D):
//     Up  se  TWAP60(últimos 60 s da janela)  >=  TWAP60(60 s ANTES do início da janela)
// com preços de 1 segundo da Binance. Mede, ao minuto M de cada janela:
//   1) a calibração de um modelo ciente da regra:   z_D = (S − P0) / (σ·√(τ − 40 s)),   P(Up) = Φ(z_D)
//        S  = preço atual,  P0 = TWAP60 de referência (fixo desde o início da janela),  τ = segundos que faltam,
//        σ  = desvio por segundo (RMS dos últimos 60 retornos de 1 min / √60).
//      O "τ − 40" vem de a média dos últimos 60 s de um passeio aleatório ter variância σ²·60/3 = 20σ² (ver nota no fim).
//   2) a mesma coisa para o modelo antigo (distância ao OPEN, tempo restante τ), para comparar Brier e log-loss;
//   3) P(Up) por deslocamento face à REFERÊNCIA (P0), em bps.
//
// A Binance (USDT) não é a Chainlink (USD): perto de 0 bps sobra incerteza. NÃO envia ordens. Precisa de rede e Node 18+.
// A 1.ª execução descarrega ~86 400 klines de 1 s por dia (1 pedido por 1000), em 4 pedidos paralelos: demora alguns minutos.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const args = process.argv.slice(2);
const opt = { coin: 'BTC', days: 30, minutes: [3, 5, 8, 10] };
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--coin') opt.coin = String(args[++i]).toUpperCase();
    else if (args[i] === '--days') opt.days = Number(args[++i]);
    else if (args[i] === '--minute') opt.minutes = String(args[++i]).split(',').map(Number);
}
const SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
if (!SYMBOL[opt.coin]) { console.log('--coin tem de ser BTC, ETH ou SOL'); process.exit(1); }
if (opt.minutes.some((m) => !(m >= 1 && m <= 14))) { console.log('--minute: valores entre 1 e 14 (ex.: 3,5,8,10)'); process.exit(1); }
const SEC = 1000, MIN = 60_000, WIN = 15 * MIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (x, d = 3) => (x === null || x === undefined || !isFinite(x) ? '-' : Number(x).toFixed(d));
function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
}

// ───────────── klines de 1 s (cache binária) ─────────────
async function load1s(symbol, days) {
    mkdirSync('cache', { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const cacheFile = `cache/klines1s-${symbol}-${days}d-${day}.bin`;
    if (existsSync(cacheFile)) {
        console.log(`(cache: ${cacheFile})`);
        const buf = readFileSync(cacheFile);
        const t0 = buf.readDoubleLE(0);
        const arr = new Float64Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + buf.length));
        return { t0, closes: arr };
    }
    const end = Math.floor(Date.now() / SEC) * SEC;
    const t0 = Math.ceil((end - days * 86_400_000) / WIN) * WIN;
    const n = Math.floor((end - t0) / SEC);
    const closes = new Float64Array(n).fill(NaN);
    const chunks = [];
    for (let s = 0; s < n; s += 1000) chunks.push(s);
    let done = 0;
    console.log(`A descarregar ${n} klines de 1 s de ${symbol} (${chunks.length} pedidos, 4 em paralelo)...`);
    const queue = [...chunks];
    await Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length) {
            const s = queue.shift();
            const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&startTime=${t0 + s * SEC}&limit=1000`;
            let rows = null;
            for (let a = 0; a < 4 && !rows; a++) {
                try {
                    const r = await fetch(url);
                    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (a + 1)); continue; }
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    rows = await r.json();
                } catch (e) {
                    if (a === 3) throw new Error(`falha a obter klines de 1 s (${e.message})`);
                    await sleep(1000 * (a + 1));
                }
            }
            for (const x of rows) {
                const i = Math.round((Number(x[0]) - t0) / SEC);
                if (i >= 0 && i < n) closes[i] = Number(x[4]);
            }
            if (++done % 100 === 0) process.stdout.write(`  ${done}/${chunks.length}\r`);
            await sleep(40);
        }
    }));
    process.stdout.write('\n');
    const head = Buffer.alloc(8);
    head.writeDoubleLE(t0, 0);
    writeFileSync(cacheFile, Buffer.concat([head, Buffer.from(closes.buffer)]));
    return { t0, closes };
}

// ───────────── janelas ─────────────
const { t0, closes } = await load1s(SYMBOL[opt.coin], opt.days);
const N = closes.length;
const idx = (t) => Math.round((t - t0) / SEC);
const at = (i) => { for (let k = 0; k < 5; k++) { const v = closes[i - k]; if (v > 0) return v; } return NaN; };
function twap(i0, len) {
    let s = 0, c = 0;
    for (let i = i0; i < i0 + len; i++) { const v = closes[i]; if (v > 0) { s += v; c++; } }
    return c >= 55 ? s / c : NaN;
}
function sigmaPerSec(iT) {
    // RMS dos 60 retornos de 1 min que terminam em iT (usa os preços de 1 s nas marcas de minuto)
    let sum = 0, n = 0;
    for (let k = 0; k < 60; k++) {
        const a = at(iT - k * 60), b = at(iT - (k + 1) * 60);
        if (a > 0 && b > 0) { sum += Math.log(a / b) ** 2; n++; }
    }
    return n >= 40 ? Math.sqrt(sum / n) / Math.sqrt(60) : NaN;
}

const wins = [];
for (let ws = t0 + 4 * 3_600_000; ws + WIN <= t0 + N * SEC; ws += WIN) {
    const i0 = idx(ws);
    const P0 = twap(i0 - 60, 60);
    const fin = twap(i0 + 900 - 60, 60);
    const open0 = at(i0);
    if (!(P0 > 0) || !(fin > 0) || !(open0 > 0)) continue;
    wins.push({ i0, P0, open0, up: fin >= P0 });
}
console.log(`\n${opt.coin}: ${wins.length} janelas | P(Up) base = ${f(wins.filter((w) => w.up).length / wins.length)} | regra D\n`);

const ZE = [-1e9, -2, -1, -0.5, 0, 0.5, 1, 2, 1e9];
const zLab = (i) => (i === 0 ? 'z<-2' : i === ZE.length - 2 ? 'z>=2' : `z ${ZE[i]}..${ZE[i + 1]}`);
const BE = [-1e9, -10, -5, -2, 0, 2, 5, 10, 1e9];
const bLab = (i) => (i === 0 ? '<-10' : i === BE.length - 2 ? '>=10' : `${BE[i]}..${BE[i + 1]}`) + ' bps';
const ci = (p, n) => (n > 0 ? 1.96 * Math.sqrt((p * (1 - p)) / n) : NaN);
const clip = (p) => Math.min(1 - 1e-4, Math.max(1e-4, p));

console.log('Comparação de modelos (menor = melhor):');
console.log('   minuto |      n | Brier: modelo D | Brier: modelo antigo | logloss D | logloss antigo | Brier base');
const detail = [];
for (const m of opt.minutes) {
    const tau = 900 - 60 * m;
    const rows = [];
    for (const w of wins) {
        const iT = w.i0 + 60 * m - 1;
        const S = at(iT), s = sigmaPerSec(iT);
        if (!(S > 0) || !(s > 0)) continue;
        const zD = (S / w.P0 - 1) / (s * Math.sqrt(tau - 40));
        const zA = (S / w.open0 - 1) / (s * Math.sqrt(tau));
        rows.push({ up: w.up, zD, zA, pD: normCdf(zD), pA: normCdf(zA), dispBps: (S / w.P0 - 1) * 1e4 });
    }
    if (!rows.length) continue;
    const brier = (k) => rows.reduce((a, r) => a + ((r[k] - (r.up ? 1 : 0)) ** 2), 0) / rows.length;
    const ll = (k) => -rows.reduce((a, r) => a + Math.log(r.up ? clip(r[k]) : 1 - clip(r[k])), 0) / rows.length;
    const base = rows.filter((r) => r.up).length / rows.length;
    const brBase = base * (1 - base);
    console.log(`   ${String(m).padStart(6)} | ${String(rows.length).padStart(6)} | ${f(brier('pD'), 4).padStart(15)} | ${f(brier('pA'), 4).padStart(20)} | ${f(ll('pD'), 4).padStart(9)} | ${f(ll('pA'), 4).padStart(14)} | ${f(brBase, 4)}`);
    detail.push({ m, rows });
}

for (const { m, rows } of detail) {
    console.log(`\n── minuto ${m} (faltam ${900 - 60 * m} s) ──`);
    console.log('   P(Up) real por z_D, contra o teórico Φ(z_D):');
    console.log('   faixa        |      n | P(Up) real (±IC95) | Φ(z_D) médio');
    for (let i = 0; i < ZE.length - 1; i++) {
        const s = rows.filter((r) => r.zD >= ZE[i] && r.zD < ZE[i + 1]);
        if (s.length < 30) continue;
        const p = s.filter((r) => r.up).length / s.length;
        const th = s.reduce((a, r) => a + r.pD, 0) / s.length;
        console.log(`   ${zLab(i).padEnd(12)} | ${String(s.length).padStart(6)} | ${f(p)} (±${f(ci(p, s.length))}) | ${f(th)}`);
    }
    console.log('   P(Up) real por deslocamento face à REFERÊNCIA P0 (TWAP60 antes do início):');
    for (let i = 0; i < BE.length - 1; i++) {
        const s = rows.filter((r) => r.dispBps >= BE[i] && r.dispBps < BE[i + 1]);
        if (s.length < 30) continue;
        const p = s.filter((r) => r.up).length / s.length;
        console.log(`   ${bLab(i).padEnd(12)} | ${String(s.length).padStart(6)} | ${f(p)} (±${f(ci(p, s.length))})`);
    }
}

console.log('\nNota: o resultado final é a média de ~60 s de preços. Num passeio aleatório, a variância dessa média, vista de 60 s antes, é σ²·60/3 = 20σ²;');
console.log('por isso a incerteza efetiva até ao resultado é (τ − 60) + 20 = τ − 40 segundos, e não τ. A tabela de calibração testa se isto bate com os dados.');
console.log('Se "Φ(z_D) médio" ficar perto de "P(Up) real", a fórmula serve; se o Brier D for menor que o do modelo antigo, a nova regra melhora a previsão.');
