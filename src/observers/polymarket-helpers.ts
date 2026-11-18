import { appendFile, mkdir } from 'fs/promises';
import path from 'path';

export type Coin = 'BTC' | 'ETH' | 'SOL';
export const COINS: Coin[] = ['BTC', 'ETH', 'SOL'];
export const WINDOW_MS = 15 * 60 * 1000;

// Em Railway: monta um Volume (ex.: /data) e define LOG_DIR=/data/logs
export const LOG_DIR = process.env.LOG_DIR || 'logs';
const CLOB_BASE = process.env.POLY_CLOB_URL || 'https://clob.polymarket.com';

// ───────────────────────── Order book (REST público) ─────────────────────────

export interface BookLevel {
    price: number;
    size: number; // em shares
}

export interface Book {
    asks: BookLevel[]; // ordenado do mais barato para o mais caro
    bids: BookLevel[]; // ordenado do mais caro para o mais barato
    fetchedAtMs: number;
    latencyMs: number;
}

let backoffUntil = 0;

/**
 * Lê o book de um token via REST público do CLOB.
 * Em caso de HTTP 429 entra em backoff global de 5 s (todas as chamadas falham até lá).
 */
export async function fetchBook(tokenId: string, timeoutMs = 3000): Promise<Book> {
    const now = Date.now();
    if (now < backoffUntil) {
        throw new Error(`rate-limit backoff (${backoffUntil - now}ms)`);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();

    try {
        const res = await fetch(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`, {
            signal: ctrl.signal
        });
        if (res.status === 429) {
            backoffUntil = Date.now() + 5000;
            throw new Error('HTTP 429');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json: any = await res.json();
        const parse = (arr: any): BookLevel[] =>
            Array.isArray(arr)
                ? arr
                      .map((l: any) => ({ price: Number(l.price), size: Number(l.size) }))
                      .filter((l) => isFinite(l.price) && isFinite(l.size) && l.size > 0)
                : [];

        const asks = parse(json.asks).sort((a, b) => a.price - b.price);
        const bids = parse(json.bids).sort((a, b) => b.price - a.price);
        const t1 = Date.now();
        return { asks, bids, fetchedAtMs: t1, latencyMs: t1 - t0 };
    } finally {
        clearTimeout(timer);
    }
}

export interface VwapResult {
    filled: number;      // shares efetivamente preenchidas
    avgPrice: number;    // preço médio ponderado (0 se filled = 0)
    cost: number;        // custo total em USDC
    worstPrice: number;  // pior nível tocado
    complete: boolean;   // true se o tamanho pedido ficou todo preenchido
}

/** Percorre os níveis do book até preencher `shares`. */
export function vwapForShares(levels: BookLevel[], shares: number): VwapResult {
    let remaining = shares;
    let cost = 0;
    let filled = 0;
    let worst = 0;

    for (const l of levels) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, l.size);
        cost += take * l.price;
        filled += take;
        remaining -= take;
        worst = l.price;
    }

    return {
        filled,
        avgPrice: filled > 0 ? cost / filled : 0,
        cost,
        worstPrice: worst,
        complete: remaining <= 1e-9
    };
}

// ───────────────────────── Mercado da janela atual ─────────────────────────

/** Só precisa destes dois métodos do teu MarketService. */
export interface MarketLike {
    scanCryptoShortTermMarkets(opts: any): Promise<any[]>;
    getMarket(conditionId: string): Promise<any>;
}

export interface WindowMarket {
    coin: Coin;
    slug: string;
    conditionId: string;
    upTokenId: string;
    downTokenId: string;
    startMs: number;
    endMs: number;
}

function getMarketWindow(market: any): { startMs: number; endMs: number } | null {
    let startMs = 0;
    let endMs = 0;

    // Slug tipo 'eth-updown-15m-1790708400': o timestamp é o INÍCIO da janela
    if (market.slug) {
        const parts = String(market.slug).split('-');
        const ts = Number(parts[parts.length - 1]);
        if (!isNaN(ts) && ts > 1700000000) {
            startMs = ts * 1000;
            endMs = startMs + WINDOW_MS;
        }
    }
    if (!endMs && market.endDate) {
        endMs = new Date(market.endDate).getTime();
        startMs = endMs - WINDOW_MS;
    }
    if (!endMs || isNaN(endMs)) return null;
    return { startMs, endMs };
}

/**
 * Descobre (e põe em cache) o mercado de 15m da janela atual para cada moeda.
 * Falhas ficam em cache negativo durante 10 s para não martelar a API.
 */
export class MarketResolver {
    private cache = new Map<Coin, WindowMarket>();
    private failedUntil = new Map<Coin, number>();

    constructor(private marketService: MarketLike) {}

    async get(coin: Coin): Promise<WindowMarket | null> {
        const now = Date.now();
        const windowEnd = (Math.floor(now / WINDOW_MS) + 1) * WINDOW_MS;

        const cached = this.cache.get(coin);
        if (cached && cached.endMs === windowEnd) return cached;

        if (now < (this.failedUntil.get(coin) ?? 0)) return null;

        try {
            const markets = await this.marketService.scanCryptoShortTermMarkets({
                coin,
                duration: '15m',
                minMinutesUntilEnd: 0,
                maxMinutesUntilEnd: 20,
                limit: 1,
                sortBy: 'endDate'
            });

            const market = markets?.[0];
            if (!market?.conditionId) throw new Error('sem mercado');

            const win = getMarketWindow(market);
            if (!win || Math.abs(win.endMs - windowEnd) > 5000) {
                throw new Error(`mercado ${market.slug} não é o da janela atual`);
            }

            const full = await this.marketService.getMarket(market.conditionId);
            const tokens: any[] = full?.tokens ?? [];
            const up = tokens.find((t: any) => t.outcome === 'Up' || t.outcome === 'Yes');
            const down = tokens.find((t: any) => t.outcome === 'Down' || t.outcome === 'No');
            const upId = up?.tokenId ?? up?.token_id;
            const downId = down?.tokenId ?? down?.token_id;
            if (!upId || !downId) throw new Error('tokens Up/Down não encontrados');

            const wm: WindowMarket = {
                coin,
                slug: market.slug,
                conditionId: market.conditionId,
                upTokenId: String(upId),
                downTokenId: String(downId),
                startMs: win.startMs,
                endMs: windowEnd
            };
            this.cache.set(coin, wm);
            return wm;
        } catch (err) {
            this.failedUntil.set(coin, now + 10_000);
            console.log('WARN', `⚠️ [observers] ${coin}: ${(err as Error).message}`);
            return null;
        }
    }
}

// ───────────── Open da janela de 15m na Binance (fallback REST) ─────────────

const BINANCE_SYMBOL: Record<Coin, string> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
// Se a Binance bloquear a tua região: BINANCE_REST_URL=https://data-api.binance.vision
const BINANCE_REST = process.env.BINANCE_REST_URL || 'https://api.binance.com';

/**
 * Obtém o preço de abertura da vela de 15m que começou em `startMs` (UTC), via REST público.
 * Serve de fallback quando o websocket não viu o início da janela (ex.: o bot arrancou a meio).
 * Guarda os valores em cache e, após uma falha, só volta a tentar passados 15 s.
 */
export class BinanceOpenCache {
    private cache = new Map<string, number>();
    private failedUntil = new Map<string, number>();

    async get(coin: Coin, startMs: number): Promise<number | null> {
        const key = `${coin}:${startMs}`;
        const hit = this.cache.get(key);
        if (hit !== undefined) return hit;
        if (Date.now() < (this.failedUntil.get(key) ?? 0)) return null;

        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            const res = await fetch(
                `${BINANCE_REST}/api/v3/klines?symbol=${BINANCE_SYMBOL[coin]}&interval=15m&startTime=${startMs}&limit=1`,
                { signal: ctrl.signal }
            ).finally(() => clearTimeout(timer));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const k: any = await res.json();
            if (!Array.isArray(k) || !k[0] || Number(k[0][0]) !== startMs) throw new Error('kline inesperada');
            const open = Number(k[0][1]);
            if (!isFinite(open) || open <= 0) throw new Error('open inválido');

            this.cache.set(key, open);
            if (this.cache.size > 200) {
                // limpeza simples: remove as entradas mais antigas
                for (const kk of [...this.cache.keys()].slice(0, 100)) this.cache.delete(kk);
            }
            return open;
        } catch {
            this.failedUntil.set(key, Date.now() + 15_000);
            return null;
        }
    }
}

// ───────────────────────── Logger JSONL ─────────────────────────

export class JsonlLogger {
    private ready = false;

    /** `echoTag`: se definido, as linhas com echo=true também vão para o stdout (backup em disco efémero). */
    constructor(private file: string, private echoTag?: string) {}

    async write(entry: Record<string, any>, echo = false) {
        if (echo && this.echoTag) {
            console.log(`${this.echoTag} ${JSON.stringify(entry)}`);
        }
        try {
            if (!this.ready) {
                await mkdir(path.dirname(this.file), { recursive: true });
                this.ready = true;
            }
            await appendFile(this.file, JSON.stringify(entry) + '\n');
        } catch (err) {
            console.log('WARN', `⚠️ [observers] falha a escrever ${this.file}: ${(err as Error).message}`);
        }
    }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
