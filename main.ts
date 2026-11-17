// Dip-buying mean-reversion bot for CBBTC/USDC.
// Buys when price dips below the 90-bar SMA, sells on reversion to the mean or on stop-loss.
import { runBars, type BarsState, type BuyInput, type SellInput, type Batch } from './vendor/makefun-bars.ts';

const SMA_PERIOD = 90;
const BUY_THRESHOLD = 0.992;       // buy when close < SMA * 0.992
const SELL_TARGET = 1.002;         // sell when close >= SMA * 1.002
const STOP_LOSS = 0.985;           // sell when value <= cost * 0.985
const STOP_COOLDOWN_BARS = 30;     // no buys for 30 bars after a stop-out
const MAX_SLIPPAGE_BPS = 100;

// State per symbol (only one in this contest, but written generically)
interface SymbolState {
  closes: number[];    // collected closes for SMA
  sma: number | null;  // current SMA value
  lastStopOutBatch: number; // batch index of last stop-out (-9999 means none yet)
}

const symState = new Map<string, SymbolState>();

function getSymState(symbol: string): SymbolState {
  let s = symState.get(symbol);
  if (s === undefined) {
    s = { closes: [], sma: null, lastStopOutBatch: -9999 };
    symState.set(symbol, s);
  }
  return s;
}

/** Compute SMA of the last SMA_PERIOD closes. */
function computeSma(closes: number[]): number | null {
  if (closes.length < SMA_PERIOD) return null;
  const slice = closes.slice(-SMA_PERIOD);
  let sum = 0;
  for (let i = 0; i < slice.length; i++) sum += slice[i];
  return sum / SMA_PERIOD;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Collect which symbols have a fresh bar in this batch
    const batchSymbols = new Set<string>();
    // Collect closes from this batch's bars
    for (const bar of batch.bars) {
      batchSymbols.add(bar.symbol);
      const ss = getSymState(bar.symbol);
      ss.closes.push(Number(bar.c));
      ss.sma = computeSma(ss.closes);
    }

    // No trading during warm-up
    if (state.warmingUp) return [];

    // Need enough history
    const orders: (BuyInput | SellInput)[] = [];

    for (const sym of state.hello.symbols) {
      if (!batchSymbols.has(sym.symbol)) continue; // no fresh bar in this batch
      const ss = getSymState(sym.symbol);
      if (ss.sma === null) continue; // haven't seen 90 closes yet

      const close = Number(state.close(sym.symbol)!);
      const held = state.positions.get(sym.symbol);

      if (held !== undefined) {
        // Holding a position: check exit conditions
        const currentValue = Number(state.value(sym.symbol, held.qty));
        const cost = Number(held.cost);

        // Stop-loss: sell if value <= cost * 0.985
        if (currentValue <= cost * STOP_LOSS) {
          orders.push({ side: 'sell', symbol: sym.symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          ss.lastStopOutBatch = batch.seq;
        }
        // Take profit: sell if close >= SMA * 1.002
        else if (close >= ss.sma * SELL_TARGET) {
          orders.push({ side: 'sell', symbol: sym.symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else {
        // Flat: check for buy opportunity
        // Buy if close < SMA * 0.992 AND at least 30 bars since last stop-out
        const batchesSinceStop = batch.seq - ss.lastStopOutBatch;
        if (close < ss.sma * BUY_THRESHOLD && batchesSinceStop >= STOP_COOLDOWN_BARS) {
          // Spend min(cash, weight room), but only if above min notional
          const weightRoom = state.weightRoom(sym.symbol);
          const spend = state.cash < weightRoom ? state.cash : weightRoom;
          const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
          if (spend >= minNotional) {
            orders.push({ side: 'buy', symbol: sym.symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
        }
      }
    }

    return orders;
  },
});
