import dotenv from 'dotenv';

dotenv.config();

export const CONFIG = {
  // Modo de simulação (True = apenas simula e loga, False = executa ordens reais na Polygon)
  dryRun: process.env.DRY_RUN === 'true' || true,

  // Credenciais da Carteira
  wallet: {
    privateKey: process.env.PRIVATE_KEY as `0x${string}`,
    funderAddress: process.env.FUNDER_ADDRESS, // Opcional se usar proxy/safe
  },

  // Parâmetros de Filtro e Execução do Smart Money
  smartMoney: {
    enabled: true,
    topN: 20,                          // Quantidade de carteiras a analisar do Leaderboard
    minWinRate: 0.55,                  // Taxa de vitória mínima (55%)
    minPnl: 1000,                      // PnL mínimo acumulado em USD
    minTrades: 10,                     // Número mínimo de trades históricos
    minProfitFactor: 1.5,              // Fator de lucro mínimo
    minConsistencyScore: 0.4,          // Consistência nos últimos N trades
    maxSingleTradeExposure: 0.4,       // Exposição máxima numa única jogada (evitar baleias descontroladas)
    checkLastNTrades: 10,              // Janela para calcular consistência
    
    // Configurações de Tamanho e Execução de Cópia
    sizeScale: 0.25,                   // Escala de tamanho em relação à carteira copiada (25%)
    maxSizePerTrade: 3.5,              // Tamanho máximo por ordem em USDC/Shares
    maxSlippage: 0.05,                 // Slippage máximo tolerado (5%)
    minTradeSize: 10,                  // Tamanho mínimo do trade
    delay: 0,                          // Atraso artificial opcional (ms)

    // Carteiras fixas de confiança (opcional)
    customWallets: [
      // '0x123...',
    ],
  },

  // Gestão de Risco Geral do Bot
  risk: {
    maxDailyLoss: 50,                  // Limite máximo de perda diária em USDC
    maxActivePositions: 10,            // Limite de posições simultâneas
  }
};

export function validateConfig() {
  if (!CONFIG.wallet.privateKey) {
    throw new Error('❌ ERRO CRÍTICO: PRIVATE_KEY não está definida nas variáveis de ambiente (.env).');
  }
  console.log('✅ Configuração validada com sucesso.');
}