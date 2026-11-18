#!/usr/bin/env node
// Uso: node analyze-stoploss.mjs [pasta-dos-logs] [--entry 600] [--sl-from 300] [--fee 0.0156] [--min-ask 0.40] [--max-ask 0.80]
//
// Simula um stop-loss nos últimos minutos usando os preços do token registados em dutch-book.jsonl
// (askUp/askDown/bidUp/bidDown, de ~30 em 30 s) e compara com segurar até à resolução.
//
//  --entry    segundos restantes na entrada simulada (default 600 = minuto 5 da janela)
//  --sl-from  o stop só está ativo quando faltam <= este valor de segundos (default 300 = últimos 5 min)
//  --fee      fee estimada, fração do valor de cada perna (default 0.0156, PLACEHOLDER)
//  --min-ask/--max-ask  só simula entradas com ask nesta faixa (default 0.40-0.80)
//
// A entrada é feita nos DOIS lados (Up e Down) de cada janela, sem sinal: o objetivo é medir o efeito do stop em si,
// não da estratégia. O resultado vem da Binance (close >= open), que é um proxy da fonte de resolução.
// Limitações: amostragem de 30 s (um stop real sai a pior preço, porque os saltos entre amostras não aparecem).
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const opt = { entry: 600, slFrom: 300, fee: 0.0156, minAsk: 0.4, maxAsk: 0.8 };
let dirArg = null;
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--entry') opt.entry = Number(args[++i]);
    else if (a === '--sl-from') opt.slFrom = Number(args[++i]);
    else if (a === '--fee') opt.fee = Number(args[++i]);
    else if (a === '--min-ask') opt.minAsk = Number(args[++i]);
    else if (a === '--max-ask') opt.maxAsk = Number(args[++i]);
    else if (!a.startsWith('--') && dirArg === null) dirArg = a;
}
const dir = dirArg || process.env.LOG_DIR || 'logs';

const f = (x, d = 3) => (x === null || x === undefined || !isFinite(x) ? '-' : Number(x).toFixed(d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a) => {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const ci = (a) => (a.length >= 2 ? 1.96 * (sd(a) / Math.sqrt(a.length)) : NaN);

const file = path.join(dir, 'dutch-book.jsonl');
if (!existsSync(file)) {
    console.log(`Ficheiro não encontrado: ${file}`);
    process.exit(1);
}

// 1) agrupar linhas por janela, em ordem temporal (secondsLeft decrescente)
const bySlug = new Map();
for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r.slug || typeof r.secondsLeft !== 'number') continue;
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push(r);
}
for (const rows of bySlug.values()) rows.sort((a, b) => b.secondsLeft - a.secondsLeft);

// 2) resultados das janelas (Binance), 8 em paralelo
const SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
const wanted = new Map();
for (const [slug, rows] of bySlug) {
    const ts = Number(slug.split('-').pop());
    if (isFinite(ts) && ts > 1.7e9 && rows[0].coin) wanted.set(slug, [rows[0].coin, ts * 1000]);
}
const outcome = new Map();
const queue = [...wanted.entries()];
const total = queue.length;
let done = 0, warned = false;
console.log(`A obter ${total} janelas à Binance (8 em paralelo)...`);

async function getOutcome(coin, startMs) {
    if (startMs + 15 * 60_000 > Date.now()) return null;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(
            `https://api.binance.com/api/v3/klines?symbol=${SYMBOL[coin]}&interval=15m&startTime=${startMs}&limit=1`,
            { signal: ctrl.signal }
        ).finally(() => clearTimeout(timer));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const k = await r.json();
        if (Array.isArray(k) && k[0] && Number(k[0][0]) === startMs) return Number(k[0][4]) >= Number(k[0][1]);
    } catch (e) {
        if (!warned) { console.log(`⚠️ falha a obter klines: ${e.message}`); warned = true; }
    }
    return null;
}
await Promise.all(
    Array.from({ length: 8 }, async () => {
        while (queue.length) {
            const [slug, [coin, st]] = queue.shift();
            outcome.set(slug, await getOutcome(coin, st));
            done++;
            if (done % 100 === 0 || done === total) console.log(`... ${done}/${total}`);
        }
    })
);

// 3) entradas simuladas
const entries = [];
for (const [slug, rows] of bySlug) {
    const up = outcome.get(slug);
    if (up === null || up === undefined) continue;

    const entryRow = rows.find((r) => r.secondsLeft <= opt.entry && r.secondsLeft > opt.entry - 60);
    if (!entryRow) continue;
    const startIdx = rows.indexOf(entryRow);

    for (const [side, askKey, bidKey, won] of [
        ['Up', 'askUp', 'bidUp', up],
        ['Down', 'askDown', 'bidDown', !up]
    ]) {
        const ask = entryRow[askKey];
        if (typeof ask !== 'number' || ask < opt.minAsk || ask > opt.maxAsk) continue;

        const pathBids = [];
        for (const r of rows.slice(startIdx + 1)) {
            if (r.secondsLeft <= opt.slFrom && r.secondsLeft >= 10 && typeof r[bidKey] === 'number') {
                pathBids.push({ sl: r.secondsLeft, bid: r[bidKey] });
            }
        }
        entries.push({ slug, side, ask, won, pathBids, holdPnl: (won ? 1 : 0) - ask - opt.fee * ask });
    }
}

console.log(`\nEntradas simuladas: ${entries.length} (janelas distintas: ${new Set(entries.map((e) => e.slug)).size})`);
console.log(`Entrada com ~${opt.entry}s restantes | stop ativo nos últimos ${opt.slFrom}s | ask ${opt.minAsk}-${opt.maxAsk} | fee ${f(opt.fee * 100, 2)}% (placeholder)`);
if (entries.length < 30) {
    console.log('Poucas entradas para tirar conclusões. Deixa o observador correr mais tempo.');
    process.exit(0);
}
const holdPnls = entries.map((e) => e.holdPnl);
console.log(`\nSEGURAR ATÉ AO FIM: PnL médio/share = ${f(mean(holdPnls), 4)} (±${f(ci(holdPnls), 4)}) | acerto ${f((entries.filter((e) => e.won).length / entries.length) * 100, 1)}% | ask médio ${f(mean(entries.map((e) => e.ask)), 3)}\n`);

// 4) stop-loss: sai ao bid quando o bid cai X% abaixo do preço de entrada
console.log('STOP-LOSS: sai quando o bid do token cai X% abaixo do preço de entrada (só nos últimos minutos)');
console.log('   X    | acionado | PnL médio SL (±IC95)  | SL − hold (±IC95)    | nos acionados: bid de saída médio → payoff final médio se segurasse');
for (const X of [0.1, 0.2, 0.3, 0.4, 0.5]) {
    const slPnls = [];
    const diffs = [];
    const exits = [];
    const finals = [];
    for (const e of entries) {
        const trigger = e.pathBids.find((p) => p.bid <= e.ask * (1 - X));
        if (trigger) {
            const pnl = trigger.bid - e.ask - opt.fee * (e.ask + trigger.bid);
            slPnls.push(pnl);
            diffs.push(pnl - e.holdPnl);
            exits.push(trigger.bid);
            finals.push(e.won ? 1 : 0);
        } else {
            slPnls.push(e.holdPnl);
            diffs.push(0);
        }
    }
    const trig = exits.length;
    console.log(
        `   ${String(Math.round(X * 100)).padStart(2)}%  | ${f((trig / entries.length) * 100, 0).padStart(4)}%    | ${f(mean(slPnls), 4).padStart(8)} (±${f(ci(slPnls), 4)})   | ${(mean(diffs) >= 0 ? '+' : '') + f(mean(diffs), 4)} (±${f(ci(diffs), 4)}) | ${trig ? `${f(mean(exits), 3)} → ${f(mean(finals), 3)} (n=${trig})` : '-'}`
    );
}
console.log('\nLeitura:');
console.log(' - "SL − hold" > 0 e com o intervalo longe de 0 => o stop acrescenta valor; ~0 ou negativo => só te custa spread e fees;');
console.log(' - nos acionados, se o payoff final médio for ≈ ao bid de saída, o preço do token já refletia a queda (mercado eficiente): vender não ganha nada;');
console.log('   se o payoff final for MAIOR, o stop vendeu perto do fundo (o preço recuperou); se for MENOR, o stop evitou perdas (momentum);');
console.log(' - a amostragem é de 30 s: os stops reais saem a pior preço do que aqui, e em books finos pode nem haver bid. O resultado do stop aqui é otimista.');
