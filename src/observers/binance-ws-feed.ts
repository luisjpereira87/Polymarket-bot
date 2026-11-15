import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { Coin, COINS } from './polymarket-helpers.js';

const STREAM_SYMBOL: Record<Coin, string> = { BTC: 'btcusdt', ETH: 'ethusdt', SOL: 'solusdt' };
const COIN_BY_SYMBOL: Record<string, Coin> = { BTCUSDT: 'BTC', ETHUSDT: 'ETH', SOLUSDT: 'SOL' };

export interface Tick {
    t: number; // hora do trade na Binance (ms)
    p: number; // preço
}

export interface MoveEvent {
    coin: Coin;
    direction: 'up' | 'down';
    changePct: number;      // variação em % dentro de windowMs
    windowMs: number;
    fromPrice: number;
    toPrice: number;
    tradeTimeMs: number;    // hora do trade que disparou (relógio da Binance)
    receivedAtMs: number;   // hora a que o nosso processo o recebeu
}

export interface BinanceWsFeedOptions {
    /**
     * Base do websocket. Default: wss://stream.binance.com:9443
     * Se o teu servidor estiver numa região bloqueada pela Binance, tenta
     * BINANCE_WS_URL=wss://data-stream.binance.vision (só market data).
     */
    baseUrl?: string;
    bufferMs?: number;                              // histórico mantido em memória (default 120 s)
    moveWindowMs?: number;                          // janela para medir o movimento (default 10 s)
    moveThresholdPct?: Partial<Record<Coin, number>>; // limiar por moeda, em %
    moveCooldownMs?: number;                        // intervalo mínimo entre eventos 'move' da mesma moeda
}

const WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_THRESHOLDS: Record<Coin, number> = { BTC: 0.06, ETH: 0.08, SOL: 0.10 };

/**
 * Feed de aggTrade da Binance (BTC/ETH/SOL vs USDT).
 * Emite 'move' (MoveEvent) quando o preço varia mais do que o limiar na janela definida.
 */
export class BinanceWsFeed extends EventEmitter {
    private ws: WebSocket | null = null;
    private stopped = true;
    private reconnectAttempts = 0;
    private lastMsgAt = 0;
    private watchdog: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;

    // Preço de abertura de cada janela de 15m, capturado a partir do primeiro trade visto.
    // `exact` só é true se estávamos ligados sem interrupções ANTES de a janela começar
    // (senão o primeiro tick que vemos pode não ser o primeiro trade da janela).
    private windowOpen = new Map<Coin, { startMs: number; price: number; exact: boolean }>();
    private connectedSince = 0; // 0 = desligado; senão, hora local a que a ligação atual abriu

    private ticks = new Map<Coin, Tick[]>();
    private lastCheck = new Map<Coin, number>();
    private lastTrim = new Map<Coin, number>();
    private lastMove = new Map<Coin, number>();

    private baseUrl: string;
    private bufferMs: number;
    private moveWindowMs: number;
    private thresholds: Record<Coin, number>;
    private moveCooldownMs: number;

    constructor(opts: BinanceWsFeedOptions = {}) {
        super();
        this.baseUrl = opts.baseUrl || process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443';
        this.bufferMs = opts.bufferMs ?? 120_000;
        this.moveWindowMs = opts.moveWindowMs ?? 10_000;
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.moveThresholdPct ?? {}) } as Record<Coin, number>;
        this.moveCooldownMs = opts.moveCooldownMs ?? 20_000;
        for (const c of COINS) this.ticks.set(c, []);
    }

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        this.connect();
        this.watchdog = setInterval(() => {
            // Se não chega nada há 20 s, força reconexão
            if (this.ws && Date.now() - this.lastMsgAt > 20_000) {
                console.log('WARN', '⚠️ [binance-ws] sem mensagens há 20 s. A reconectar...');
                this.ws.terminate();
            }
        }, 10_000);
    }

    stop() {
        this.stopped = true;
        if (this.watchdog) clearInterval(this.watchdog);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.watchdog = null;
        this.reconnectTimer = null;
        this.ws?.terminate();
        this.ws = null;
    }

    /** Último preço conhecido (null se ainda não houver dados). */
    getPrice(coin: Coin): number | null {
        const arr = this.ticks.get(coin);
        return arr && arr.length ? arr[arr.length - 1].p : null;
    }

    /**
     * Preço de abertura da janela de 15m que começou em `startMs`.
     * Devolve null se não temos a certeza de que é o primeiro trade da janela
     * (por exemplo, o bot arrancou ou reconectou a meio dela). Nesse caso usa o REST.
     */
    getWindowOpen(coin: Coin, startMs: number): number | null {
        const w = this.windowOpen.get(coin);
        return w && w.startMs === startMs && w.exact ? w.price : null;
    }

    /** Idade (ms) do último tick da moeda; Infinity se não houver. */
    getAgeMs(coin: Coin): number {
        const arr = this.ticks.get(coin);
        return arr && arr.length ? Date.now() - arr[arr.length - 1].t : Infinity;
    }

    private connect() {
        if (this.stopped) return;

        const streams = COINS.map((c) => `${STREAM_SYMBOL[c]}@aggTrade`).join('/');
        const url = `${this.baseUrl}/stream?streams=${streams}`;
        console.log('INFO', `🔌 [binance-ws] a ligar a ${this.baseUrl} ...`);

        const ws = new WebSocket(url);
        this.ws = ws;

        ws.on('open', () => {
            this.reconnectAttempts = 0;
            this.lastMsgAt = Date.now();
            this.connectedSince = Date.now();
            console.log('INFO', '✅ [binance-ws] ligado.');
        });

        ws.on('message', (data: WebSocket.RawData) => {
            this.lastMsgAt = Date.now();
            try {
                const msg = JSON.parse(data.toString());
                const d = msg?.data;
                if (d?.e === 'aggTrade') this.onTrade(d);
            } catch {
                /* mensagem inválida: ignora */
            }
        });

        ws.on('error', (err: Error) => {
            console.log('WARN', `⚠️ [binance-ws] erro: ${err.message}`);
        });

        ws.on('close', (code: number) => {
            this.connectedSince = 0;
            console.log('WARN', `⚠️ [binance-ws] ligação fechada (${code}).`);
            this.scheduleReconnect();
        });
    }

    private scheduleReconnect() {
        if (this.stopped) return;
        if (this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
        console.log('INFO', `🔁 [binance-ws] reconexão em ${(delay / 1000).toFixed(0)}s (tentativa ${this.reconnectAttempts}).`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private onTrade(d: any) {
        const coin = COIN_BY_SYMBOL[d.s];
        if (!coin) return;

        const p = Number(d.p);
        const t = Number(d.T);
        if (!isFinite(p) || !isFinite(t)) return;

        const arr = this.ticks.get(coin)!;
        arr.push({ t, p });

        // Captura do open da janela de 15m: primeiro trade visto com a hora da janela nova
        const startMs = Math.floor(t / WINDOW_MS) * WINDOW_MS;
        const curOpen = this.windowOpen.get(coin);
        if (!curOpen || curOpen.startMs !== startMs) {
            const exact = this.connectedSince > 0 && this.connectedSince <= startMs - 1000;
            this.windowOpen.set(coin, { startMs, price: p, exact });
        }

        // Limpeza em lote (no máximo 1 vez por segundo por moeda)
        const nowMs = Date.now();
        if (nowMs - (this.lastTrim.get(coin) ?? 0) > 1000) {
            this.lastTrim.set(coin, nowMs);
            const cutoff = t - this.bufferMs;
            let i = 0;
            while (i < arr.length && arr[i].t < cutoff) i++;
            if (i > 0) arr.splice(0, i);
        }

        // Verificação de movimento (no máximo a cada 200 ms por moeda)
        if (nowMs - (this.lastCheck.get(coin) ?? 0) < 200) return;
        this.lastCheck.set(coin, nowMs);

        const from = t - this.moveWindowMs;
        let ref: Tick | null = null;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i].t >= from) {
                ref = arr[i];
                break;
            }
        }
        if (!ref || ref.t >= t) return;

        const changePct = ((p - ref.p) / ref.p) * 100;
        if (Math.abs(changePct) < this.thresholds[coin]) return;
        if (nowMs - (this.lastMove.get(coin) ?? 0) < this.moveCooldownMs) return;
        this.lastMove.set(coin, nowMs);

        const ev: MoveEvent = {
            coin,
            direction: changePct > 0 ? 'up' : 'down',
            changePct,
            windowMs: this.moveWindowMs,
            fromPrice: ref.p,
            toPrice: p,
            tradeTimeMs: t,
            receivedAtMs: nowMs
        };
        this.emit('move', ev);
    }
}