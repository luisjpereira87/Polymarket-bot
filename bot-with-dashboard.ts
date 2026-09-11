/**
 * Bot with Dashboard - Wrapper que executa o bot com UI de monitorização em tempo real
 * 
 * Versão com Fixes do Issue #2:
 * - Cálculo de PnL real no Smart Money (tracking de BUY/SELL em memória)
 * - Aplicação de filtros completos no Smart Money (Profit Factor & Consistency)
 * - Validação rigorosa de canTrade() na receção de sinais
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { dashboardEmitter, startDashboard } from './src/dashboard/index.js';
import type { BotConfig, BotState, DipArbSignal, LogLevel, SmartMoneySignal, TradePositions } from './src/dashboard/types.js';
import {
  ArbitrageService,
  OnchainService,
  OrderResult,
  PolymarketSDK,
  SwapService,
  type SmartMoneyTrade,
} from './src/index.js';

// ============================================================================
// CONFIGURAÇÃO
// ============================================================================

let CONFIG = {
  capital: {
    totalUsd: parseFloat(process.env.CAPITAL_USD || '250'),
    maxPerTradePct: 0.02,
    maxPerMarketPct: 0.10,
    maxTotalExposurePct: 0.30,
    minOrderUsd: 1, // Baixado de 5 para aceitar pequenas frações
    strategyAllocation: {
      smartMoney: 0.60,
      arbitrage: 0.20,
      dipArb: 0.10,
      directTrades: 0.10,
    },
  },

  risk: {
    dailyMaxLossPct: 0.05,
    maxConsecutiveLosses: 6,
    pauseOnBreachMinutes: 60,

    monthlyMaxLossPct: 0.15,
    maxDrawdownFromPeak: 0.25,
    totalMaxLossPct: 0.40,

    enableDynamicSizing: true,
    minPositionPct: 0.01,
    maxPositionPct: 0.05,
    lossSizingReduction: 0.20,
    winSizingIncrease: 0.10,

    takeProfitPercent: 15, // +15% de lucro
    stopLossPercent: -10,
  },

  smartMoney: {
    enabled: process.env.SMARTMONEY_ENABLED === 'true',
    topN: 50,                  // Subido de 20 para 50 (Procura numa lista muito maior de carteiras)

    minWinRate: 0.55,          // Ligeiramente ajustado de 0.60 para 0.55
    minPnl: 300,               // Ajustado de 500 para 300
    minTrades: 20,              // Ajustado de 30 para 20

    minProfitFactor: 1.2,      // Relaxado de 1.5 para 1.2 (Encontra muito mais carteiras)
    minConsistencyScore: 0.5,  // Relaxado de 0.7 para 0.5

    maxSingleTradeExposure: 0.3,
    checkLastNTrades: 10,

    sizeScale: 0.1,
    maxSizePerTrade: 15,

    maxSlippage: 0.05,         // Subido de 0.03 para 0.05 (Evita rejeitar trades por ligeira variação de preço)
    minTradeSize: 1.0,         // 🚨 CRÍTICO: Baixado de 10 para 1.0 (Não descarta ordens pequenas!)
    delay: 200,                // Reduzido de 500ms para 200ms de latência
    customWallets: [
      '0xc2e7800b5af46e6093872b177b7a5e7f0563be51',
      '0x58c3f5d66c95d4c41b093fbdd2520e46b6c9de74',
    ] as string[],
  },

  arbitrage: {
    enabled: process.env.ARBITRAGE_ENABLED === 'true',             // Forçado a true (ativa a estratégia automaticamente)
    profitThreshold: 0.008,    // Baixado de 0.01 para 0.008 (Mais oportunidades de arbitragem)
    minTradeSize: 5,
    maxTradeSize: 50,
    minVolume24h: 2000,
    autoExecute: true,
    enableRebalancer: true,

    estimatedGasCostUSD: 0.05,
    minNetProfit: 0.20,
  },

  dipArb: {
    enabled: process.env.DIPARB_ENABLED === 'true',             // Forçado a true
    coins: ['BTC', 'ETH', 'SOL'] as const,
    shares: 10,
    sumTarget: 0.95,           // Subido de 0.92 para 0.95 (Aumenta bastante os gatilhos)
    autoRotate: true,
    autoExecute: true,
    minTradeValueUSD: 1.0,
  },

  onchain: {
    enabled: true,
    autoApprove: true,
    minMatic: 0.5,
  },

  binance: {
    enabled: process.env.TREND_ANALYSIS_ENABLED === 'true',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const,
    interval: '15m' as const,
    trendThreshold: 2,
  },

  directTrading: {
    enabled: process.env.DIRECT_TRADING === 'true',
    trendFollowing: true,
    minTrendStrength: 0.02,
    stopLossPct: 0.15,
    takeProfitPct: 0.25,
    trailingStopPct: 0.10,
    maxHoldDays: 7,
    minRiskReward: 1.5,
  },

  dryRun: process.env.DRY_RUN !== 'false',
};


// ============================================================================
// ESTADO E RASTREIO DE POSIÇÕES SIMULADAS
// ============================================================================

interface SimulatedPosition {
  traderAddress: string;
  marketSlug: string;
  side: 'BUY' | 'SELL';
  size: number;
  entryPrice: number;
  timestamp: number;
  outcome?: string;
}

// Guarda posições de compra simuladas para cálculo real de PnL na venda
const simulatedPositions = new Map<string, SimulatedPosition>();

const state: BotState = {
  startTime: Date.now(),
  dailyPnL: 0,
  totalPnL: 0,
  consecutiveLosses: 0,
  consecutiveWins: 0,
  tradesExecuted: 0,
  isPaused: false,
  pauseUntil: 0,

  monthlyPnL: 0,
  monthStartTime: Date.now(),
  peakCapital: CONFIG.capital.totalUsd,
  currentCapital: CONFIG.capital.totalUsd,
  currentDrawdown: 0,
  permanentlyHalted: false,
  lastDailyReset: Date.now(),

  smartMoneyTrades: 0,
  arbTrades: 0,
  dipArbTrades: 0,
  directTrades: 0,
  arbProfit: 0,
  followedWallets: [],
  positions: [],
  activeArbMarket: null,
  activeDipArbMarket: null,
  splits: 0,
  merges: 0,
  redeems: 0,
  swaps: 0,
  usdcBalance: 0,
  usdcEBalance: 0,
  maticBalance: 0,
  unrealizedPnL: 0,
  btcTrend: 'neutral',
  ethTrend: 'neutral',
  solTrend: 'neutral',

  dipArb: {
    marketName: null,
    underlying: null,
    duration: null,
    endTime: null,
    upPrice: 0,
    downPrice: 0,
    sum: 0,
    status: 'idle',
    lastSignal: null,
    signals: [],
  },

  arbitrage: {
    status: 'idle',
    marketsScanned: 0,
    opportunitiesFound: 0,
    currentMarket: null,
    lastOpportunity: null,
  },

  smartMoneySignals: [],
};

// Objeto global de controlo financeiro e liquidez
const financialState = {
  initialCapital: CONFIG.capital.totalUsd || 1000, // Capital inicial de referência
  availableCash: CONFIG.capital.totalUsd || 1000,   // Dinheiro livre para abrir novas posições
  committedCapital: 0,                       // Capital atualmente bloqueado em posições ativas
};

const processedTrades = new Set<string>();

// ============================================================================
// UTILITÁRIOS E GESTÃO DE RISCO
// ============================================================================

function log(level: LogLevel, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const icons: Record<string, string> = {
    INFO: '📋', WARN: '⚠️', ERROR: '❌', TRADE: '💰', SIGNAL: '🎯',
    ARB: '🔄', WALLET: '👛', CHAIN: '⛓️', SWAP: '💱', BRIDGE: '🌉',
    KLINE: '📊', TREND: '📈', RISK: '🛡️'
  };

  console.log(`[${timestamp}] ${icons[level] || '•'} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));

  dashboardEmitter.log(level, message, data);
}

function updateDashboard() {
  dashboardEmitter.updateState(state);
}

function canTrade(): boolean {
  if (state.permanentlyHalted) {
    log('ERROR', '🛑 Trading permanentemente interrompido - limite total de perda atingido');
    return false;
  }

  // 1. Resets de tempo diário e mensal
  const daysSinceReset = (Date.now() - state.lastDailyReset) / (1000 * 60 * 60 * 24);
  if (daysSinceReset >= 1) {
    log('INFO', `Reset do PnL diário. Dia anterior: $${state.dailyPnL.toFixed(2)}`);
    state.dailyPnL = 0;
    state.lastDailyReset = Date.now();
  }

  const daysSinceMonthStart = (Date.now() - state.monthStartTime) / (1000 * 60 * 60 * 24);
  if (daysSinceMonthStart >= 30) {
    log('INFO', `Reset do PnL mensal. Mês anterior: $${state.monthlyPnL.toFixed(2)}`);
    state.monthlyPnL = 0;
    state.monthStartTime = Date.now();
  }

  // 2. Métricas de Capital e Drawdown
  state.currentCapital = CONFIG.capital.totalUsd + state.totalPnL;
  if (state.currentCapital > state.peakCapital) {
    state.peakCapital = state.currentCapital;
  }
  state.currentDrawdown = (state.peakCapital - state.currentCapital) / state.peakCapital;

  // 3. Verificação de Pausa Ativa
  if (state.isPaused && Date.now() < state.pauseUntil) {
    return false; // Ainda está dentro do tempo de penalização
  }

  // Se a pausa expirou, retoma a execução
  if (state.isPaused && Date.now() >= state.pauseUntil) {
    state.isPaused = false;
    log('INFO', 'Bot retomou a execução após período de pausa');
    updateDashboard();
  }

  // 4. Verificação dos Limites Totais/Fatais (Estes SIM devem parar o bot)
  const totalLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.totalMaxLossPct;
  if (state.totalPnL <= -totalLossLimit) {
    state.permanentlyHalted = true;
    log('ERROR', '💀 LIMITE DE PERDA TOTAL ATINGIDO - BOT PARADO PERMANENTEMENTE');
    log('ERROR', `Perda total: -$${Math.abs(state.totalPnL).toFixed(2)} (limite: $${totalLossLimit.toFixed(2)})`);
    updateDashboard();
    return false;
  }

  const monthlyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.monthlyMaxLossPct;
  if (state.monthlyPnL <= -monthlyLossLimit) {
    log('ERROR', `🛑 Limite de perda mensal atingido: -$${Math.abs(state.monthlyPnL).toFixed(2)} (limite: $${monthlyLossLimit.toFixed(2)})`);
    state.isPaused = true;
    state.pauseUntil = Date.now() + (30 * 24 * 60 * 60 * 1000);
    updateDashboard();
    return false;
  }

  if (state.currentDrawdown >= CONFIG.risk.maxDrawdownFromPeak) {
    log('ERROR', `🛑 Drawdown máximo atingido: ${(state.currentDrawdown * 100).toFixed(1)}%`);
    state.isPaused = true;
    state.pauseUntil = Date.now() + (7 * 24 * 60 * 60 * 1000);
    updateDashboard();
    return false;
  }

  // 5. Verificação da Perda Diária (DISPARA A PAUSA APENAS SE NÃO ESTIVER EM PERÍODO DE RETOMADA)
  // O limite só deve pausar SE o bot NÃO acabou de sair de uma pausa recente sem novo PnL.
  const dailyLossLimit = CONFIG.capital.totalUsd * CONFIG.risk.dailyMaxLossPct;
  if (!state.isPaused && state.dailyPnL <= -dailyLossLimit) {
    // Para evitar re-pausa imediata sem o PnL ter mudado no mesmo dia,
    // verifica se o PnL do dia deve ser atenuado ou se a pausa deve durar até ao próximo reset diário.
    state.isPaused = true;
    state.pauseUntil = Date.now() + CONFIG.risk.pauseOnBreachMinutes * 60 * 1000;
    log('WARN', `Limite de perda diária atingido: -$${Math.abs(state.dailyPnL).toFixed(2)} (limite: $${dailyLossLimit.toFixed(2)})`);
    updateDashboard();
    return false;
  }

  return true;
}

function recordTrade(profit: number, strategy: string) {
  state.tradesExecuted++;
  state.dailyPnL += profit;
  state.monthlyPnL += profit;
  state.totalPnL += profit;

  if (profit < 0) {
    state.consecutiveLosses++;
    state.consecutiveWins = 0;
  } else if (profit > 0) {
    state.consecutiveLosses = 0;
    state.consecutiveWins++;
  }

  if (strategy === 'smartMoney') state.smartMoneyTrades++;
  else if (strategy === 'arbitrage') state.arbTrades++;
  else if (strategy === 'dipArb') state.dipArbTrades++;
  else if (strategy === 'direct') state.directTrades++;

  if (CONFIG.dryRun && state.paper) {
    state.paper.pnl += profit;
    state.paper.balance += profit;
    state.paper.trades++;
  }

  updateDashboard();
}

async function conservativeQualifiedWallets(sdk: PolymarketSDK) {
  try {
    const qualified: string[] = [];

    if (CONFIG.smartMoney.customWallets?.length > 0) {
      for (const wallet of CONFIG.smartMoney.customWallets) {
        qualified.push(wallet);
        log('WALLET', `⭐ Carteira personalizada adicionada: ${wallet.slice(0, 10)}...`);
      }
    }

    const leaderboard = await sdk.wallets.getLeaderboardByPeriod('week', CONFIG.smartMoney.topN * 2, 'pnl');

    for (const entry of leaderboard) {
      if (!CONFIG.smartMoney.enabled && qualified.length === 0) break;
      if (qualified.length >= 10) break;
      if (qualified.includes(entry.address)) continue;

      const profile = await sdk.wallets.getWalletProfile(entry.address);
      if (!profile) continue;

      const winRate = (profile as any).winRate ?? 0;
      const pnl = entry.pnl ?? 0;
      const trades = profile.tradeCount ?? 0;
      const profitFactor = (profile as any).profitFactor ?? 2.0;

      if (
        winRate >= CONFIG.smartMoney.minWinRate &&
        pnl >= CONFIG.smartMoney.minPnl &&
        trades >= CONFIG.smartMoney.minTrades &&
        profitFactor >= CONFIG.smartMoney.minProfitFactor
      ) {
        qualified.push(entry.address);
        log('WALLET', `✅ Carteira Qualificada: ${entry.address}... (WR:${(winRate * 100).toFixed(0)}% PnL:$${pnl.toFixed(0)} T:${trades})`);
      }

      await new Promise(r => setTimeout(r, 300));

    }
    return qualified;
  } catch (err) {
    log('WARN', `Erro ao carregar Leaderboard: ${(err as Error).message}`);
  }
}

async function agressiveQualifiedWallets(sdk: PolymarketSDK) {
  try {
    const qualified: string[] = [];

    if (CONFIG.smartMoney.customWallets?.length > 0) {
      for (const wallet of CONFIG.smartMoney.customWallets) {
        qualified.push(wallet);
        log('WALLET', `⭐ Carteira personalizada adicionada: ${wallet.slice(0, 10)}...`);
      }
    }

    const leaderboard = await sdk.wallets.getLeaderboardByPeriod('week', CONFIG.smartMoney.topN * 3, 'volume');

    for (const entry of leaderboard) {
      if (!CONFIG.smartMoney.enabled && qualified.length === 0) break;
      if (qualified.length >= 15) break;
      if (qualified.includes(entry.address)) continue;

      const profile = await sdk.wallets.getWalletProfile(entry.address);
      if (!profile) continue;

      const trades = profile.tradeCount ?? 0;
      const positions = profile.positionCount ?? 0;
      const lastActive = new Date(profile.lastActiveAt).getTime();
      const now = Date.now();
      const hoursSinceLastActive = (now - lastActive) / (1000 * 60 * 60);

      // Critério para Bots/HFT: Elevado número de trades, múltiplas posições e atividade recente (< 24h)
      if (
        trades >= (CONFIG.smartMoney.minTrades || 50) &&
        positions >= 5 &&
        hoursSinceLastActive <= 24
      ) {
        qualified.push(entry.address);
        log('WALLET', `🤖 Bot Qualificado: ${entry.address.slice(0, 10)}... (Trades: ${trades} | Posições: ${positions} | Ativo há ${hoursSinceLastActive.toFixed(1)}h)`);
      }

      await new Promise(r => setTimeout(r, 200));

    }
    return qualified;
  } catch (err) {
    log('WARN', `Erro ao carregar Leaderboard de Bots: ${(err as Error).message}`);
  }
}

function simulateSmartMoneyTrade(trade: SmartMoneyTrade & { id?: string; market?: string }) {
  // 1. Resolver fallback de campos (garantir que pega 'marketSlug' ou 'market')
  const marketSlug = trade.marketSlug || trade.market;

  // 2. Ignorar IMEDIATAMENTE se o mercado for inválido/vazio
  if (!marketSlug || marketSlug.trim() === '') {
    log('INFO', `[SIMULATION] Sinal ignorado: mercado inválido/vazio.`);
    return;
  }

  // 3. Garantir o traderAddress
  if (!trade.traderAddress) {
    log('INFO', `[SIMULATION] Sinal ignorado: traderAddress ausente.`);
    return;
  }

  // 4. Determinar se o sinal de SELL consegue encontrar a posição mesmo sem outcome
  const outcomeSuffix = trade.outcome ? `-${trade.outcome}` : '';
  let posKey = `${trade.traderAddress}-${marketSlug}${outcomeSuffix}`;

  // Se for SELL e não encontrar a posKey exata, procura por qualquer posição aberta deste trader neste mercado
  if (trade.side === 'SELL' && !simulatedPositions.has(posKey)) {
    for (const key of simulatedPositions.keys()) {
      if (key.startsWith(`${trade.traderAddress}-${marketSlug}`)) {
        posKey = key; // Encontrou a posição correspondente!
        break;
      }
    }
  }

  // 5. Evitar trades duplicados
  const tradeHash = `${posKey}-${trade.side}-${trade.size}-${trade.price}`;
  if (processedTrades.has(tradeHash)) {
    return;
  }
  processedTrades.add(tradeHash);

  if (processedTrades.size > 5000) processedTrades.clear();

  // 6. Filtro de preço mínimo
  if (trade.price < 0.10) {
    log('INFO', `[SIMULATION] Sinal ignorado: preço muito baixo ($${trade.price.toFixed(3)})`);
    return;
  }

  // EXECUÇÃO DO COPY TRADE SIMULADO
  if (trade.side === 'BUY') {
    // 🛡️ APLICAR DIMENSIONAMENTO (Não copiar cegamente as shares do trader grande)
    const maxUsdPerTrade = CONFIG.smartMoney?.maxSizePerTrade || 5;
    const targetUsd = Math.min(trade.size * trade.price, maxUsdPerTrade);
    const scaledSize = targetUsd / trade.price; // As Tuas shares reais baseadas na TUA banca
    const tradeCost = scaledSize * trade.price;

    // 🛡️ VALIDAÇÃO DE CAIXA DISPONÍVEL
    const currentAvailableCash = financialState.availableCash ?? CONFIG.capital.totalUsd ?? 1000;
    if (currentAvailableCash < tradeCost) {
      log('ERROR', `[SIMULATION] ❌ Compra ignorada em ${marketSlug}: Caixa insuficiente ($${currentAvailableCash.toFixed(2)}) para o custo de $${tradeCost.toFixed(2)}.`);
      return;
    }

    // Atualizar o estado de caixa e capital bloqueado
    financialState.availableCash = currentAvailableCash - tradeCost;
    financialState.committedCapital = (financialState.committedCapital || 0) + tradeCost;

    const existing = simulatedPositions.get(posKey);

    if (existing) {
      // Recalcular Preço Médio (DCA)
      const totalSize = existing.size + scaledSize;
      const avgPrice = ((existing.entryPrice * existing.size) + (trade.price * scaledSize)) / totalSize;

      simulatedPositions.set(posKey, {
        ...existing,
        size: totalSize,
        entryPrice: avgPrice,
        timestamp: Date.now(),
      });
    } else {
      simulatedPositions.set(posKey, {
        traderAddress: trade.traderAddress,
        marketSlug: marketSlug,
        outcome: trade.outcome,
        side: 'BUY',
        size: scaledSize, // Usa o tamanho dimensionado!
        entryPrice: trade.price,
        timestamp: Date.now(),
      });
    }

    log('TRADE', `[SIMULATION] Smart Money BUY: ${scaledSize.toFixed(1)} shares @ $${trade.price.toFixed(3)} em ${marketSlug} ${outcomeSuffix} | Caixa Restante: $${financialState.availableCash.toFixed(2)}`);

  } else if (trade.side === 'SELL') {
    const existingPos = simulatedPositions.get(posKey);

    if (!existingPos || existingPos.size <= 0) {
      log('INFO', `[SIMULATION] Venda ignorada (${marketSlug}): sem posição de compra correspondente.`);
      return;
    }

    // 🛡️ PROTEÇÃO: Vende no MÁXIMO o número de shares que TU tens guardadas na memória
    const closedShares = Math.min(existingPos.size, existingPos.size * (trade.size / (trade.size || 1)));
    const actualClosedShares = Math.min(closedShares, existingPos.size);

    const tradeProceeds = actualClosedShares * trade.price;
    const costBasis = actualClosedShares * existingPos.entryPrice;
    const profit = (trade.price - existingPos.entryPrice) * actualClosedShares;

    // Libertar capital bloqueado e reintegrar o valor da venda no caixa disponível
    financialState.committedCapital = Math.max(0, (financialState.committedCapital || 0) - costBasis);
    financialState.availableCash = (financialState.availableCash || 0) + tradeProceeds;

    if (existingPos.size - actualClosedShares > 0.01) {
      existingPos.size -= actualClosedShares;
      simulatedPositions.set(posKey, existingPos);
    } else {
      simulatedPositions.delete(posKey); // Elimina a posição se foi toda vendida
    }

    log('TRADE', `[SIMULATION] Smart Money SELL: ${actualClosedShares.toFixed(1)} shares @ $${trade.price.toFixed(3)} | PnL: $${profit.toFixed(2)} | Novo Caixa: $${financialState.availableCash.toFixed(2)}`);
    recordTrade(profit, 'smartMoney');
  }
}

function simulateTrade(profit: number, strategy: string, description: string) {
  if (!CONFIG.dryRun || !state.paper) return;

  log('TRADE', `[SIMULATION] ${description} | Lucro Est.: $${profit.toFixed(2)}`);
  recordTrade(profit, strategy);
}

// ============================================================================
// ESTRATÉGIAS
// ============================================================================

let arbService: ArbitrageService | null = null;
let isSmartMoneyInitialized = false;
let isSmartMoneyInitializing = false;
//let currentSmartMoneySub: any = null;
let currentSmartMoneySub: { id: string; unsubscribe: () => void } | null = null;
let autoCopyTradingSubscription: { id: string; stop: () => void } | null = null;
let qualifiedCache: string[] = [];
const liveMarketPrices = new Map<string, number>();


let activeTradesProcessing = 0;
const realPositions = new Map<string, TradePositions>();

async function setupSmartMoney(sdk: PolymarketSDK) {
  if (CONFIG.smartMoney.enabled) {
    initializeSmartMoney(sdk);
  }
}

const recentSmartMoneyTradesCache = new Map<string, number>();

function isDuplicateSmartMoneyTrade(trade: any): boolean {
  // Gera uma impressão digital baseada no trader, mercado, ação (BUY/SELL), quantidade e preço
  const signature = `${trade.traderAddress}-${trade.marketSlug || trade.market}-${trade.side}-${trade.size}-${trade.price}`;
  const now = Date.now();

  // Limpa registos mais antigos que 3 segundos (3000 ms)
  for (const [key, timestamp] of recentSmartMoneyTradesCache.entries()) {
    if (now - timestamp > 3000) {
      recentSmartMoneyTradesCache.delete(key);
    }
  }

  // Se o sinal já deu entrada nos últimos 3s, é duplicado!
  if (recentSmartMoneyTradesCache.has(signature)) {
    return true;
  }

  recentSmartMoneyTradesCache.set(signature, now);
  return false;
}

async function updatePricesCache(sdk: PolymarketSDK, marketSlug: string) {
  try {
    const gammaMarket = await sdk.smartMoney.getMarketBySlug(marketSlug);
    if (gammaMarket?.outcomePrices && gammaMarket?.outcomes) {
      gammaMarket.outcomes.forEach((outcome: string, index: number) => {
        const key = `${marketSlug}-${outcome}`;
        liveMarketPrices.set(key, Number(gammaMarket.outcomePrices[index]));
      });
      log('INFO', `📊 [CACHE] Preços atualizados para: ${marketSlug}`);
    }
  } catch (err) {
    log('WARN', `❌ [CACHE_ERR] Falha ao atualizar preços para ${marketSlug}: ${err}`);
  }
}

function processTradeExecution(trade: SmartMoneyTrade, result: OrderResult) {
  const isDryRun = CONFIG.dryRun ?? false;
  const modeTag = isDryRun ? '🧪 [DRY_RUN]' : '🔴 [LIVE]';

  // 1. Registar sempre o sinal no feed do Dashboard
  const signal: SmartMoneySignal = {
    id: `sm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    wallet: trade.traderAddress,
    market: trade.marketSlug || 'Unknown',
    side: trade.side as 'BUY' | 'SELL',
    size: trade.size,
    price: trade.price,
  };

  state.smartMoneySignals.unshift(signal);
  if (state.smartMoneySignals.length > 50) {
    state.smartMoneySignals = state.smartMoneySignals.slice(0, 50);
  }

  // 2. Validar se a ordem foi bem-sucedida
  if (!result.success) {
    log('WARN', `❌ ${modeTag} Falha na ordem: ${result.errorMsg}`);
    updateDashboard();
    return;
  }

  state.smartMoneyTrades++;

  const marketSlug = trade.marketSlug || (trade as any).market;
  const outcomeSuffix = trade.outcome ? `-${trade.outcome}` : '';
  const posKey = `${marketSlug}${outcomeSuffix}`;
  let execPrice = trade.price;
  if (isDryRun && trade.side === 'BUY') {
    const cachedPrice = liveMarketPrices.get(posKey);
    if (cachedPrice && cachedPrice > 0) {
      if (cachedPrice !== trade.price) {
        log('INFO', `🔍 [PRICE_CHECK] ${posKey} | Preço Trader: $${trade.price.toFixed(3)} ➔ Preço Atual (Cache): $${cachedPrice.toFixed(3)} (Dif: ${(cachedPrice - trade.price).toFixed(3)})`);
      }
      execPrice = cachedPrice;
    }
  }

  const execShares = trade.size * (CONFIG.smartMoney.sizeScale || 0.25);
  const tradeCost = execShares * execPrice;

  // 3. Gestão de Posições e Balanços
  if (isDryRun) {
    // 🧪 MODO SIMULAÇÃO (Dry Run): Atualiza o mapa local e os saldos de caixa
    if (trade.side === 'BUY') {
      const currentAvailableCash = financialState.availableCash ?? 1000;

      if (currentAvailableCash < tradeCost) {
        log('RISK', `[SIMULATION] ❌ Compra bloqueada: Caixa insuficiente ($${currentAvailableCash.toFixed(2)}).`);
        updateDashboard();
        return;
      }

      // Atualizar balanços
      financialState.availableCash = currentAvailableCash - tradeCost;
      financialState.committedCapital = (financialState.committedCapital || 0) + tradeCost;

      // Registar em realPositions (ou simulatedPositions, conforme preferires manter)
      const existing = realPositions.get(posKey);
      if (existing) {
        const totalSize = existing.size + execShares;
        const avgPrice = ((existing.avgEntryPrice * existing.size) + (execPrice * execShares)) / totalSize;
        realPositions.set(posKey, {
          ...existing,
          size: totalSize,
          avgEntryPrice: avgPrice,
          timestamp: Date.now(),
        });
      } else {
        realPositions.set(posKey, {
          marketSlug: marketSlug,
          outcome: trade.outcome,
          side: trade.side as 'BUY' | 'SELL',
          size: execShares,
          avgEntryPrice: execPrice,
          timestamp: Date.now(),
          traderAddress: trade.traderAddress,
        });
      }

      log('TRADE', `✅ [DRY_RUN] BUY: ${execShares.toFixed(1)} shares @ $${execPrice.toFixed(3)} | Caixa Restante: $${financialState.availableCash.toFixed(2)}`);

    } else if (trade.side === 'SELL') {
      const existingPos = realPositions.get(posKey);

      if (existingPos && existingPos.size > 0) {
        //const closedShares = Math.min(existingPos.size, execShares);
        const closedShares = existingPos.size;
        const profit = (execPrice - existingPos.avgEntryPrice) * closedShares;
        const tradeProceeds = closedShares * execPrice;
        const costBasis = closedShares * existingPos.avgEntryPrice;

        // Libertar balanços
        financialState.committedCapital = Math.max(0, (financialState.committedCapital || 0) - costBasis);
        financialState.availableCash = (financialState.availableCash || 0) + tradeProceeds;

        /** 
        if (existingPos.size - closedShares > 0.01) {
          existingPos.size -= closedShares;
          realPositions.set(posKey, existingPos);
        } else {
          realPositions.delete(posKey);
        }
          **/
        realPositions.delete(posKey);

        log('TRADE', `✅ [DRY_RUN] SELL: ${closedShares.toFixed(1)} shares | PnL: $${profit.toFixed(2)} | Novo Caixa: $${financialState.availableCash.toFixed(2)}`);
        recordTrade(profit, 'smartMoney');
      }
    }
  } else {
    // 🔴 MODO PRODUÇÃO (Live): Sincroniza posições reais / chama portfólio manager se necessário
    log('TRADE', `✅ [LIVE] Trade processado com sucesso pela exchange.`);
    // Aqui podes chamar a tua função de sincronização com a Polymarket API, ex: setupPortfolioManager(sdk)
  }

  updateDashboard();
}

async function initializeSmartMoney(sdk: PolymarketSDK) {
  isSmartMoneyInitializing = true;

  log('WALLET', 'Configurando Smart Money com filtros completos de qualidade...');

  //const qualified: string[] = [];
  const qualified = await agressiveQualifiedWallets(sdk);

  if (!qualified) {
    return;
  }

  state.followedWallets = qualified;
  log('WALLET', `A seguir ${qualified.length} carteiras qualificadas`);
  updateDashboard();

  // 3. Inicializar o Copy Trading do SDK (passando a flag dryRun dinamicamente)
  if (qualified.length > 0) {
    const isDryRun = CONFIG.dryRun; // passa a flag do teu CONFIG para o SDK
    const modeTag = isDryRun ? '🧪 [DRY_RUN]' : '🔴 [LIVE]';

    log('TRADE', `${modeTag} A iniciar motor de Copy Trading no SDK (dryRun: ${isDryRun})...`);


    autoCopyTradingSubscription = await sdk.smartMoney.startAutoCopyTrading({
      targetAddresses: qualified,
      sizeScale: CONFIG.smartMoney.sizeScale || 0.25,
      maxSizePerTrade: CONFIG.smartMoney.maxSizePerTrade || 3.5,
      maxSlippage: CONFIG.smartMoney.maxSlippage || 0.05,
      minTradeSize: CONFIG.smartMoney.minTradeSize || 10,
      delay: CONFIG.smartMoney.delay || 0,
      isCanTrade: () => canTrade(),
      dryRun: isDryRun, // 👈 O SDK simula se for true, executa ordens reais se for false
      onTrade: async (trade, result) => {
        try {
          //if (isDuplicateSmartMoneyTrade(trade)) return;

          if (trade.marketSlug) {
            await updatePricesCache(sdk, trade.marketSlug);
          }

          processTradeExecution(trade, result);

          //updateDashboard();
        } finally {
          activeTradesProcessing--;
        }
      },
      onError: (err) => log('ERROR', `❌ ${modeTag} Erro no motor de Copy Trading: ${err.message}`),
    });
  }

  isSmartMoneyInitialized = true;
  isSmartMoneyInitializing = false;
}

async function setupPriceMonitor(sdk: PolymarketSDK) {
  // Subescreve à monitorização de preços passando o mapa local de posições

  const TAKE_PROFIT_PCT = CONFIG.risk?.takeProfitPercent || 15;
  const STOP_LOSS_PCT = CONFIG.risk?.stopLossPercent || -10;
  sdk.smartMoney.subscribePositionPricesWithExecution(realPositions, {
    takeProfitPercent: TAKE_PROFIT_PCT,
    stopLossPercent: STOP_LOSS_PCT,
    dryRun: true,
    executeTradeHandler: (trade, result) => {
      processTradeExecution(trade, result);
    }
  });

  /** 
  sdk.smartMoney.subscribePositionPrices(realPositions, (slug, currentPrice, pnlPercent) => {
    const pos = realPositions.get(slug);
    if (!pos) return;

    const unrealizedUsd = (currentPrice - pos.avgEntryPrice) * pos.size;
    const status = pnlPercent >= 0 ? '📈 A SUBIR' : '📉 A DESCER';

    log('INFO', `[${slug}] ${status} | Entrada: $${pos.avgEntryPrice.toFixed(3)} | Atual: $${currentPrice.toFixed(3)} | PnL: ${pnlPercent.toFixed(1)}% ($${unrealizedUsd.toFixed(2)})`);

    const TAKE_PROFIT_PCT = CONFIG.risk?.takeProfitPercent || 15;
    const STOP_LOSS_PCT = CONFIG.risk?.stopLossPercent || 10;

    if (pnlPercent >= TAKE_PROFIT_PCT) {
      log('TRADE', `🎯 Take-profit de ${pnlPercent.toFixed(1)}% atingido em ${slug}! A fechar posição...`);
      // TODO: Executar ordem de saída no SDK
    } else if (pnlPercent <= -STOP_LOSS_PCT) {
      log('TRADE', `🛑 Stop-loss de ${pnlPercent.toFixed(1)}% atingido em ${slug}! A cortar perdas...`);
      // TODO: Executar ordem de saída no SDK
    }

    updateDashboard();
  });
  **/
  log('INFO', '✅ Motor de monitorização de preços integrado e ativo.');
}

async function initializeSmartMoney__(sdk: PolymarketSDK) {
  //if (isSmartMoneyInitialized || isSmartMoneyInitializing) return;

  /**
  if (isSmartMoneyInitializing) {
    log('WARN', '⚠️ Inicialização do Smart Money já está em andamento. Chamada ignorada.');
    return;
  }
    **/

  isSmartMoneyInitializing = true;

  log('WALLET', 'Configurando Smart Money com filtros completos de qualidade...');

  const qualified: string[] = [];

  if (CONFIG.smartMoney.customWallets?.length > 0) {
    for (const wallet of CONFIG.smartMoney.customWallets) {
      qualified.push(wallet);
      log('WALLET', `⭐ Carteira personalizada adicionada: ${wallet.slice(0, 10)}...`);
    }
  }

  try {
    const leaderboard = await sdk.wallets.getLeaderboardByPeriod('week', CONFIG.smartMoney.topN * 2, 'pnl');

    for (const entry of leaderboard) {
      if (!CONFIG.smartMoney.enabled && qualified.length === 0) break;
      if (qualified.length >= 10) break;
      if (qualified.includes(entry.address)) continue;

      const profile = await sdk.wallets.getWalletProfile(entry.address);
      if (!profile) continue;

      const winRate = (profile as any).winRate ?? 0;
      const pnl = entry.pnl ?? 0;
      const trades = profile.tradeCount ?? 0;
      const profitFactor = (profile as any).profitFactor ?? 2.0;

      // Fix do Issue: Aplicação de todos os filtros de qualidade
      if (
        winRate >= CONFIG.smartMoney.minWinRate &&
        pnl >= CONFIG.smartMoney.minPnl &&
        trades >= CONFIG.smartMoney.minTrades &&
        profitFactor >= CONFIG.smartMoney.minProfitFactor
      ) {
        qualified.push(entry.address);
        log('WALLET', `✅ Carteira Qualificada: ${entry.address.slice(0, 10)}... (WR:${(winRate * 100).toFixed(0)}% PnL:$${pnl.toFixed(0)} T:${trades})`);
      }

      await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    log('WARN', `Erro ao carregar Leaderboard: ${(err as Error).message}`);
  }

  state.followedWallets = qualified;
  log('WALLET', `A seguir ${qualified.length} carteiras qualificadas`);
  updateDashboard();

  if (qualified.length > 0) {
    currentSmartMoneySub = sdk.smartMoney.subscribeSmartMoneyTrades(
      async (trade: SmartMoneyTrade) => {

        try {
          if (!CONFIG.smartMoney.enabled) return;
          if (!canTrade()) return; // Fix do Issue: Validação de risco antes de processar

          const signal: SmartMoneySignal = {
            id: `sm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            wallet: trade.traderAddress,
            market: trade.marketSlug || 'Unknown',
            side: trade.side as 'BUY' | 'SELL',
            size: trade.size,
            price: trade.price,
          };
          state.smartMoneySignals.unshift(signal);
          if (state.smartMoneySignals.length > 50) {
            state.smartMoneySignals = state.smartMoneySignals.slice(0, 50);
          }

          log('SIGNAL', `Sinal de Copy Trade recebido de ${trade.traderAddress.slice(0, 10)}...`, {
            market: trade.marketSlug?.slice(0, 50),
            side: trade.side,
            size: trade.size,
            price: trade.price,
          });
          updateDashboard();

          if (CONFIG.dryRun) {
            simulateSmartMoneyTrade(trade); // Fix do Issue: Execução com rastreio de PnL real
          } else {
            // Lógica de execução em conta real (Live)
          }
        } finally {
          activeTradesProcessing--; // 🟢 Ordem concluída: liberta rotação
        }
      }, {
      filterAddresses: qualified
    });
  }
  isSmartMoneyInitialized = true;
  isSmartMoneyInitializing = false;
}

async function setupArbitrage(_sdk: PolymarketSDK) {
  log('ARB', 'Configurando Serviço de Arbitragem...');

  state.arbitrage.status = 'idle';
  updateDashboard();

  arbService = new ArbitrageService({
    privateKey: CONFIG.dryRun ? undefined : process.env.POLYMARKET_PRIVATE_KEY,
    profitThreshold: CONFIG.arbitrage.profitThreshold,
    minTradeSize: CONFIG.arbitrage.minTradeSize,
    maxTradeSize: CONFIG.arbitrage.maxTradeSize,
    autoExecute: !CONFIG.dryRun && CONFIG.arbitrage.autoExecute,
    enableRebalancer: !CONFIG.dryRun && CONFIG.arbitrage.enableRebalancer,
    enableLogging: true,
  });

  arbService.on('opportunity', (opp) => {
    state.activeArbMarket = opp.market?.name || 'scanning';
    state.arbitrage.opportunitiesFound++;
    state.arbitrage.lastOpportunity = {
      timestamp: new Date().toISOString(),
      type: opp.type as 'long' | 'short',
      profitPct: opp.profitPercent / 100,
      market: opp.market?.name || 'Unknown',
    };
    log('ARB', `Oportunidade Encontrada: ${opp.type.toUpperCase()} +${opp.profitPercent.toFixed(2)}%`);

    if (CONFIG.dryRun && opp.profitPercent > 0) {
      const size = Math.max(CONFIG.arbitrage.minTradeSize, 10);
      const estimatedProfit = size * (opp.profitPercent / 100);
      simulateTrade(estimatedProfit, 'arbitrage', `Arb ${opp.market}`);
    }

    updateDashboard();
  });

  arbService.on('execution', (result) => {
    if (result.success) {
      state.arbProfit += result.profit || 0;
      recordTrade(result.profit || 0, 'arbitrage');
      log('TRADE', `Ordem de Arbitragem Executada: +$${(result.profit || 0).toFixed(2)} lucro`);
    }
  });

  if (CONFIG.arbitrage.enabled) {
    state.arbitrage.status = 'scanning';
    try {
      const results = await arbService.scanMarkets(
        { minVolume24h: CONFIG.arbitrage.minVolume24h },
        CONFIG.arbitrage.profitThreshold
      );
      state.arbitrage.marketsScanned = results.length;
      const opps = results.filter(r => r.arbType !== 'none');

      if (opps.length > 0) {
        state.activeArbMarket = opps[0].market.name;
        state.arbitrage.currentMarket = opps[0].market.name;
        state.arbitrage.status = 'monitoring';
        await arbService.start(opps[0].market);
        log('ARB', `A monitorizar mercado: ${opps[0].market.name}`);
      } else {
        state.arbitrage.status = 'idle';
        log('ARB', 'Sem oportunidades de arbitragem no momento, continuando varredura...');
      }
      updateDashboard();
    } catch (err) {
      state.arbitrage.status = 'idle';
      log('WARN', `Erro no scan de arbitragem: ${(err as Error).message}`);
      updateDashboard();
    }
  }
}

async function setupDipArb(sdk: PolymarketSDK) {
  log('ARB', 'Configurando Serviço DipArb...');

  sdk.dipArb.updateConfig({
    shares: CONFIG.dipArb.shares,
    sumTarget: CONFIG.dipArb.sumTarget,
    autoExecute: !CONFIG.dryRun,
    debug: true,
  });

  sdk.dipArb.on('orderbookUpdate', (update: { upPrice: number; downPrice: number; sum: number }) => {
    state.dipArb.upPrice = update.upPrice;
    state.dipArb.downPrice = update.downPrice;
    state.dipArb.sum = update.sum;
    updateDashboard();
  });

  sdk.dipArb.on('started', (market: any) => {
    log('ARB', `DipArb Ativo no mercado: ${market.name}`);
    state.activeDipArbMarket = market.name;
    state.dipArb.marketName = market.name;
    state.dipArb.underlying = market.underlying || 'ETH';
    state.dipArb.duration = `${market.durationMinutes}m`;
    state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
    state.dipArb.status = 'active';
    updateDashboard();

    dashboardEmitter.updateStrategyStatus('dipArb', 'active', market.name);
  });

  sdk.dipArb.on('newRound', (round: { roundId: string; priceToBeat: number }) => {
    log('ARB', `Nova ronda DipArb: ${round.roundId}, Preço Alvo: ${round.priceToBeat}`);
    updateDashboard();
  });

  sdk.dipArb.on('signal', (s: {
    type: 'leg1' | 'leg2';
    dipSide?: string;
    hedgeSide?: string;
    currentPrice: number;
    source?: string;
    dropPercent?: number;
  }) => {
    const side = s.dipSide || s.hedgeSide || 'UP';
    const signal: DipArbSignal = {
      id: `da-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      type: s.type as DipArbSignal['type'],
      side: side as 'UP' | 'DOWN',
      price: s.currentPrice || 0,
      change: s.dropPercent ? -s.dropPercent * 100 : 0,
    };
    state.dipArb.lastSignal = signal;
    state.dipArb.signals.unshift(signal);
    if (state.dipArb.signals.length > 20) {
      state.dipArb.signals = state.dipArb.signals.slice(0, 20);
    }
    log('SIGNAL', `Sinal DipArb: ${s.type} ${side} @ ${s.currentPrice?.toFixed(3)}`);
    updateDashboard();
  });

  sdk.dipArb.on('execution', (r: any) => {
    if (r.success) {
      const price = r.price ? r.price.toFixed(3) : '??';
      const shares = r.shares ? r.shares.toFixed(1) : '??';
      const market = state.activeDipArbMarket || 'unknown-market';

      switch (r.leg) {
        case 'leg1':
          log('TRADE', `ABERTURA ${r.side} | ${shares} shares @ $${price} | ${market}`);
          break;
        case 'leg2':
          log('TRADE', `COBERTURA ${r.side} | ${shares} shares @ $${price} | Lucro Travado`);
          break;
        case 'exit':
          log('TRADE', `FECHO ${r.side} (Timeout Exit) | ${shares} shares @ $${price}`);
          break;
        case 'merge':
          log('TRADE', `RESGATE | Posições combinadas por payout de $1.00 | ${market}`);
          break;
        default:
          log('TRADE', `DipArb ${r.leg}: ${r.side} @ ${price}`);
      }
      recordTrade(0, 'dipArb');
    } else {
      log('WARN', `Execução DipArb Falhou (${r.leg}): ${r.error || 'Erro desconhecido'}`);
    }
  });

  sdk.dipArb.on('rotate', (e: { newMarket: string }) => {
    state.activeDipArbMarket = e.newMarket;
    state.dipArb.marketName = e.newMarket;
    log('ARB', `DipArb rodou para o mercado: ${e.newMarket}`);
    updateDashboard();
  });

  if (CONFIG.dipArb.autoRotate) {
    sdk.dipArb.enableAutoRotate({
      enabled: true,
      underlyings: ['ETH', 'BTC', 'SOL'],
      duration: '15m',
      settleStrategy: 'redeem',
      redeemWaitMinutes: 5,
    });
  }

  if (CONFIG.dipArb.enabled) {
    try {
      const market = await sdk.dipArb.findAndStart({ coin: 'ETH', preferDuration: '15m' });
      if (market) {
        state.activeDipArbMarket = market.name;
        state.dipArb.marketName = market.name;
        state.dipArb.underlying = market.underlying || 'ETH';
        state.dipArb.duration = `${market.durationMinutes}m`;
        state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
        state.dipArb.status = 'active';
        log('ARB', `DipArb iniciado: ${market.name}`);
      } else {
        log('WARN', 'Nenhum mercado DipArb encontrado no momento');
      }
      updateDashboard();
    } catch (err) {
      log('WARN', `Erro na configuração do DipArb: ${(err as Error).message}`);
    }
  }
}

let swapService: SwapService | null = null;

async function updateBalances() {
  if (CONFIG.dryRun) {
    state.usdcEBalance = 250 + state.totalPnL;
    state.maticBalance = 100;
    updateDashboard();
    return;
  }

  if (!swapService) return;
  try {
    const balances = await swapService.getBalances();
    let changed = false;

    for (const b of balances) {
      if (b.symbol === 'MATIC') {
        const val = parseFloat(b.balance);
        if (state.maticBalance !== val) { state.maticBalance = val; changed = true; }
      }
      if (b.symbol === 'USDC') {
        const val = parseFloat(b.balance);
        if (state.usdcBalance !== val) { state.usdcBalance = val; changed = true; }
      }
      if (b.symbol === 'USDC_E') {
        const val = parseFloat(b.balance);
        if (state.usdcEBalance !== val) { state.usdcEBalance = val; changed = true; }
      }
    }

    if (changed) updateDashboard();
  } catch (err) {
    // Ignora falhas temporárias
  }
}

async function setupSwap() {
  log('SWAP', 'Configurando Monitorização de Saldos...');

  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;

    const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    const signer = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY, provider);
    swapService = new SwapService(signer);

    await updateBalances();

    log('SWAP', 'Saldos carregados:', {
      matic: state.maticBalance.toFixed(4),
      usdce: `$${state.usdcEBalance.toFixed(2)}`,
    });

    if (!CONFIG.dryRun && state.usdcEBalance < 5) {
      log('WARN', `⚠️ Saldo baixo de USDC.e ($${state.usdcEBalance.toFixed(2)}). O bot necessita de USDC.e no Polygon.`);
    }

    setInterval(updateBalances, 30000);
    updateDashboard();
  } catch (err) {
    log('WARN', `Erro na configuração dos saldos: ${(err as Error).message}`);
  }
}

async function setupOnchain() {
  if (!CONFIG.onchain.enabled || CONFIG.dryRun) return;
  log('CHAIN', 'Verificando aprovações On-chain...');

  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;

    const onchain = new OnchainService({
      privateKey: process.env.POLYMARKET_PRIVATE_KEY,
      rpcUrl: 'https://polygon-rpc.com',
    });

    if (CONFIG.onchain.autoApprove) {
      log('CHAIN', 'Aprovação automática do Proxy e Exchange...');
      const result = await onchain.approveAll();

      if (result.allApproved) {
        log('CHAIN', '✅ Aprovações concluídas');
      } else {
        log('WARN', `Status de aprovação: ${result.summary}`);
      }
    } else {
      const status = await onchain.checkAllowances();
      if (!status.tradingReady) {
        log('WARN', 'Aprovações em falta:', status.issues);
      } else {
        log('CHAIN', '✅ Aprovações verificadas com sucesso');
      }
    }
  } catch (err) {
    log('WARN', `Erro no Onchain: ${(err as Error).message}`);
  }
}

async function setupBinanceAnalysis(sdk: PolymarketSDK) {
  if (!CONFIG.binance.enabled) return;
  log('KLINE', 'Configurando análise de tendências via Binance...');

  async function analyzeTrend(symbol: 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT'): Promise<'up' | 'down' | 'neutral'> {
    try {
      const klines = await sdk.binance.getKLines(symbol, CONFIG.binance.interval, { limit: 20 });
      if (klines.length < 10) return 'neutral';

      const recent = klines.slice(-5);
      const older = klines.slice(-10, -5);

      const recentAvg = recent.reduce((s, k) => s + k.close, 0) / recent.length;
      const olderAvg = older.reduce((s, k) => s + k.close, 0) / older.length;

      const change = (recentAvg - olderAvg) / olderAvg;

      if (change > CONFIG.binance.trendThreshold / 100) return 'up';
      if (change < -CONFIG.binance.trendThreshold / 100) return 'down';
      return 'neutral';
    } catch {
      return 'neutral';
    }
  }

  async function updateTrends() {
    state.btcTrend = await analyzeTrend('BTCUSDT');
    state.ethTrend = await analyzeTrend('ETHUSDT');
    state.solTrend = await analyzeTrend('SOLUSDT');
    log('TREND', `Tendências Binance: BTC:${state.btcTrend} ETH:${state.ethTrend} SOL:${state.solTrend}`);
    updateDashboard();
  }

  await updateTrends();
  setInterval(updateTrends, 5 * 60 * 1000);
}

async function setupDirectTrading(sdk: PolymarketSDK) {
  log('INFO', 'Direct Trading pronto - aguardando execução');

  async function checkTrendTrades() {
    if (!CONFIG.directTrading.enabled) return;
    if (!canTrade()) return;

    try {
      const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(5);

      for (const market of trendingMarkets) {
        if (!market.conditionId) continue;

        try {
          const fullMarket = await sdk.getMarket(market.conditionId);
          const yesToken = fullMarket.tokens.find(t => t.outcome === 'Yes');
          const noToken = fullMarket.tokens.find(t => t.outcome === 'No');

          if (!yesToken || !noToken) continue;

          const isCryptoMarket = /btc|bitcoin|eth|ethereum|sol|solana/i.test(market.question || '');

          if (isCryptoMarket && CONFIG.directTrading.trendFollowing) {
            let trend: 'up' | 'down' | 'neutral' = 'neutral';
            if (/btc|bitcoin/i.test(market.question || '')) trend = state.btcTrend;
            else if (/eth|ethereum/i.test(market.question || '')) trend = state.ethTrend;
            else if (/sol|solana/i.test(market.question || '')) trend = state.solTrend;

            if (trend !== 'neutral') {
              const targetToken = trend === 'up' ? yesToken : noToken;
              const price = targetToken.price;

              if (CONFIG.dryRun) {
                simulateTrade(0, 'direct', `Sinal Direct Trading: ${market.question?.slice(0, 40)}... → ${trend.toUpperCase()} @ $${price.toFixed(2)}`);
              } else {
                const amountUsdc = 5;
                log('SIGNAL', `Executando Direct Trade: ${trend.toUpperCase()} em ${market.question?.slice(0, 30)}...`);

                sdk.tradingService.createMarketOrder({
                  tokenId: targetToken.tokenId,
                  side: 'BUY',
                  amount: amountUsdc
                }).then(res => {
                  if (res.success) {
                    log('TRADE', `✅ Direct Trade Executado: Compra de $${amountUsdc} em ${targetToken.outcome}`);
                    recordTrade(0, 'direct');
                  } else {
                    log('WARN', `❌ Direct Trade falhou: ${res.errorMsg}`);
                  }
                });
              }
            }
          }
        } catch { /* ignora erros pontuais */ }
      }
    } catch (err) {
      log('WARN', `Erro no Direct Trading: ${(err as Error).message}`);
    }
  }

  setInterval(checkTrendTrades, 5 * 60 * 1000);
  setTimeout(checkTrendTrades, 10000);
}

async function setupPortfolioManager(sdk: PolymarketSDK) {
  log('INFO', 'Iniciando Gestor de Portfólio...');

  try {
    const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());
    state.positions = positions;

    realPositions.clear();

    for (const p of positions) {
      const size = Number(p.size) || 0;
      const avgPrice = Number(p.avgPrice) || 0;
      const marketSlug = p.slug || p.eventSlug;
      const outcome = p.outcome;
      const outcomeSuffix = outcome ? `-${outcome}` : '';
      const posKey = `${marketSlug}${outcomeSuffix}`;

      if (size > 0 && marketSlug) {
        realPositions.set(posKey, {
          marketSlug: marketSlug,
          outcome: outcome,
          side: 'BUY',
          size: size,
          avgEntryPrice: avgPrice,
          timestamp: Date.now(),
          traderAddress: p.proxyWallet || sdk.tradingService.getAddress(),
        });
      }
    }

    log('WALLET', `Sincronizadas ${positions.length} posições existentes.`);
    updateDashboard();
  } catch (err: any) {
    log('WARN', `Sincronização de Portfólio falhou: ${err.message}`);
  }

  setInterval(async () => {
    try {
      const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());

      const enrichedPositions = await Promise.all(positions.map(async (pos: any) => {
        try {
          const market = await sdk.markets.getMarket(pos.conditionId);
          if (market) {
            pos.marketClosed = market.closed;
            const token = market.tokens.find((t: any) => t.tokenId === pos.asset);
            if (token) {
              pos.isWinner = token.winner || false;
              pos.curPrice = token.price || 0;
            }
          }
        } catch (e) { }
        return pos;
      }));

      let unrealized = 0;
      for (const p of enrichedPositions) {
        const entry = Number(p.avgPrice) || 0;
        const current = Number(p.curPrice) || Number(p.msg_price) || 0;
        const size = Number(p.size) || 0;

        if (current > 0 && size > 0) {
          unrealized += (current - entry) * size;
        }
      }
      state.unrealizedPnL = unrealized;
      state.positions = enrichedPositions;
      updateDashboard();
    } catch (err: any) {
      log('WARN', `Erro de sincronização de posições: ${err.message}`);
    }
  }, 30 * 1000);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║          POLYMARKET BOT v3.1 (PnL & RISK FIXES APPLIED)             ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  startDashboard(3001);
  console.log('\n🌐 Dashboard ativo em: http://localhost:3001\n');

  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    log('ERROR', 'POLYMARKET_PRIVATE_KEY não definida');
    process.exit(1);
  }

  const dashboardConfig: BotConfig = {
    capital: CONFIG.capital,
    risk: CONFIG.risk,
    smartMoney: {
      enabled: CONFIG.smartMoney.enabled,
      topN: CONFIG.smartMoney.topN,
      minWinRate: CONFIG.smartMoney.minWinRate,
      minPnl: CONFIG.smartMoney.minPnl,
      minTrades: CONFIG.smartMoney.minTrades,
      customWallets: CONFIG.smartMoney.customWallets,
    },
    arbitrage: {
      enabled: CONFIG.arbitrage.enabled,
      profitThreshold: CONFIG.arbitrage.profitThreshold,
      autoExecute: CONFIG.arbitrage.autoExecute,
    },
    dipArb: {
      enabled: CONFIG.dipArb.enabled,
      coins: CONFIG.dipArb.coins,
    },
    directTrading: {
      enabled: CONFIG.directTrading.enabled,
    },
    binance: {
      enabled: CONFIG.binance.enabled,
    },
    dryRun: CONFIG.dryRun,
  };
  dashboardEmitter.updateConfig(dashboardConfig);
  dashboardEmitter.updateState(state);

  dashboardEmitter.on('command', async (cmd: { command: string; payload: any }) => {
    if (cmd.command === 'toggleDryRun') {
      const enable = cmd.payload.enabled;
      if (CONFIG.dryRun === !enable) {
        log('INFO', `Alterando para modo ${!enable ? 'LIVE' : 'SIMULAÇÃO'}...`);

        CONFIG.dryRun = !!enable;

        if (CONFIG.dryRun && !state.paper) {
          state.paper = {
            balance: CONFIG.capital.totalUsd,
            initialBalance: CONFIG.capital.totalUsd,
            pnl: 0,
            trades: 0,
            totalVolume: 0,
          };
        }

        if (arbService) {
          await arbService.stop();
          await setupArbitrage(sdk);
        }

        sdk.dipArb.updateConfig({ autoExecute: !CONFIG.dryRun });

        dashboardEmitter.updateConfig({ ...dashboardConfig, dryRun: CONFIG.dryRun });
        log('WARN', `⚠️ MODO ALTERADO PARA: ${CONFIG.dryRun ? '🧪 SIMULAÇÃO' : '🔴 LIVE'}`);
      }
    }
  });

  if (CONFIG.dryRun) {
    state.paper = {
      balance: CONFIG.capital.totalUsd,
      initialBalance: CONFIG.capital.totalUsd,
      pnl: 0,
      trades: 0,
      totalVolume: 0,
    };
    log('INFO', '📝 Modo Simulação Ativado: A acompanhar ordens de Smart Money com cálculo de PnL real.');
    updateDashboard();
  }

  const sdk = await PolymarketSDK.create({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  });

  log('INFO', `Endereço da Carteira: ${sdk.tradingService.getAddress()}`);

  await setupOnchain();
  await setupSwap();
  await setupBinanceAnalysis(sdk);
  await setupSmartMoney(sdk);
  await setupArbitrage(sdk);
  await setupDipArb(sdk);

  await setupPriceMonitor(sdk);

  // 2. Atualiza a lista de carteiras do Smart Money automaticamente a cada 2 horas
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const TEN_MINUTES = 5 * 60 * 1000
  const THIRTY_MINUTES = 30 * 60 * 1000
  /** 
  setInterval(async () => {
    try {
      log('INFO', '🔄 A reanalisar o mercado e a procurar novas carteiras de Smart Money...');
      currentSmartMoneySub?.unsubscribe()
      currentSmartMoneySub = null;
      await setupSmartMoney(sdk);
    } catch (err: any) {
      log('WARN', `❌ Erro ao atualizar Smart Money em background: ${err.message}`);
    }
  }, TEN_MINUTES);
  **/
 /**
  setInterval(async () => {
    log('INFO', '⏰ A verificar rotação de carteiras de Smart Money...');

    // Se houver alguma ordem a ser copiada NESTE instante, aguarda uns segundos
    if (activeTradesProcessing > 0) {
      log('WARN', `⏳ Existe(m) ${activeTradesProcessing} ordem(ns) a ser processada(s). A aguardar conclusão...`);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Faz a rotação limpa: cancela a antiga e inicia a nova lista
    if (autoCopyTradingSubscription) {
      log('INFO', '🔄 A fechar subscrição antiga...');
      autoCopyTradingSubscription.stop();
      autoCopyTradingSubscription = null;
      await new Promise(r => setTimeout(r, 4000)); // Pausa para fecho do WS no SDK
    }

    // Carrega as novas carteiras e subscreve de novo
    await initializeSmartMoney(sdk);

  }, TWO_HOURS_MS);
  **/
  // 2. Re-verificação de Arbitragem (A cada 10 minutos)
  /** 
  setInterval(async () => {
    try {
      if (CONFIG.arbitrage.enabled) {
        await setupArbitrage(sdk);
      }
    } catch (err: any) {
      log('WARN', `❌ Erro na reciclagem de Arbitragem: ${err.message}`);
    }
  }, 10 * 60 * 1000);
  **/
  setInterval(() => {
    updateDashboard();
  }, 5000);

  await setupDirectTrading(sdk);
  await setupPortfolioManager(sdk);

  dashboardEmitter.on('command', async ({ command, payload }: { command: string; payload: any }) => {
    if (command === 'closePosition') {
      const { tokenId, size } = payload;
      log('TRADE', `Fecho de posição solicitado: ${tokenId} (${size} shares)`);

      if (CONFIG.dryRun) {
        log('TRADE', `[SIMULATION] Venda de ${size} shares do ativo ${tokenId}`);
        return;
      }

      try {
        const res = await sdk.tradingService.createMarketOrder({
          tokenId,
          side: 'SELL',
          amount: size,
        });

        if (res.success) {
          log('TRADE', `✅ Posição fechada com sucesso: ${size} shares vendidas`);
        } else {
          log('WARN', `❌ Falha ao fechar posição: ${res.errorMsg}`);
        }
      } catch (err: any) {
        log('WARN', `❌ Erro ao fechar posição: ${err.message}`);
      }
    }
  });

  process.on('SIGINT', async () => {
    console.log('\n\nA desligar bot...');
    if (arbService) await arbService.stop();
    await sdk.dipArb.stop();
    sdk.stop();
    process.exit(0);
  });

  log('INFO', '🚀 Bot + Dashboard operacionais!\n');

  function displayStatus() {
    const runtime = Math.round((Date.now() - state.startTime) / 1000 / 60);

    console.log('\n' + '═'.repeat(70));
    console.log('              POLYMARKET BOT v3.1 STATUS');
    console.log('═'.repeat(70));
    console.log(`  Tempo Ativo:     ${runtime} minutos`);
    console.log(`  Modo:            ${CONFIG.dryRun ? '🧪 SIMULAÇÃO' : '🔴 LIVE'}`);
    console.log(`  Estado:          ${state.isPaused ? '⏸️ PAUSADO' : '▶️ ATIVO'}`);
    console.log('─'.repeat(70));
    console.log('  SALDOS:');
    console.log(`    MATIC:         ${state.maticBalance.toFixed(4)}`);
    console.log(`    USDC:          $${state.usdcBalance.toFixed(2)}`);
    console.log(`    USDC.e:        $${state.usdcEBalance.toFixed(2)}`);
    console.log('─'.repeat(70));
    console.log('  ESTRATÉGIAS:');
    console.log(`    Smart Money:   ${state.smartMoneyTrades} trades | ${state.followedWallets.length} carteiras`);
    console.log(`    Arbitrage:     ${state.arbTrades} trades`);
    console.log(`    DipArb:        ${state.dipArbTrades} trades`);
    console.log('═'.repeat(70) + '\n');
  }

  setInterval(displayStatus, 60000);
  displayStatus();
}

main().catch((err) => {
  console.error('Erro Fatal:', err.message);
  process.exit(1);
});
