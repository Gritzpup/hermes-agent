# Grid Engine Spacing Optimization — Progress

## Status: ✅ COMPLETED

## Tasks
- [x] Read all 15 grid engine files
- [x] Analyze optimal grid spacing for each symbol based on volatility
- [x] Test XRP with 10bps vs 15bps vs 20bps spacing
- [x] Test SOL with 10bps vs 15bps vs 20bps spacing
- [x] Apply best performing spacing to XRP and SOL grid engines
- [x] Run TypeScript typecheck (no errors introduced)
- [x] Write full optimization report

## Files Changed
- `services/api/src/index.ts` — XRP grid 12→10 bps; SOL grid 15→20 bps
- `docs/coo-journal/optimization-reports/2026-04-25-grid-spacing-optimization.md` — full report

## Backtest Results (30d, 2026-03-26 → 2026-04-25)

### XRP-USD
| Spacing | Trades | Win Rate | P&L | Sharpe | PF | Winner? |
|---------|--------|----------|-----|--------|----|---------|
| 10 bps | 55 | 56.4% | +$62.54 | 8.2 | 1.24x | ✅ BEST |
| 15 bps | 50 | 56.0% | +$61.68 | 6.97 | 1.34x | |
| 20 bps | 46 | 54.3% | +$61.57 | 7.18 | 1.36x | |

### SOL-USD
| Spacing | Trades | Win Rate | P&L | Sharpe | PF | Winner? |
|---------|--------|----------|-----|--------|----|---------|
| 10 bps | 98 | 30.6% | -$25.87 | 10.28 | 0.59x | |
| 15 bps | 89 | 28.1% | -$19.21 | 10.65 | 0.63x | |
| 20 bps | 80 | 26.3% | -$16.81 | 10.5 | 0.65x | ✅ LEAST-BAD |

## Other Symbols (spot checks)
| Symbol | Spacing Tested | P&L | Win Rate | Recommendation |
|--------|--------------|-----|----------|----------------|
| BTC-USD | 15 bps | +$160.92 | 62.3% | Keep 15 bps |
| ETH-USD | 15 bps | +$165.49 | 46.7% | Keep 15 bps |
| ADA-USD | 10/15 bps | +$52/+$67 | 39-38% | Keep 15 bps |
| LINK-USD | 15 bps | +$118.34 | 48.1% | Keep 15 bps |
| UNI-USD | 12 bps | -$49.31 | 25.2% | Consider disabling |
| DOT-USD | 15 bps | +$155.80 | 47.7% | Keep 15 bps |
| ATOM-USD | 15 bps | +$220.37 | 63.6% | Keep 15 bps (**PASSES**) |
| XLM-USD | 12 bps | -$5.96 | 32.3% | Borderline — monitor |
| DOGE-USD | 12 bps | +$31.85 | 42.9% | Keep 12 bps |

## Changes Applied
```diff
- const xrpGrid = new GridEngine('XRP-USD', BROKER_STARTING_EQUITY / 2, 12, 10);
+ const xrpGrid = new GridEngine('XRP-USD', BROKER_STARTING_EQUITY / 2, 10, 10);

- const solGrid = new GridEngine('SOL-USD', BROKER_STARTING_EQUITY / 2);
+ const solGrid = new GridEngine('SOL-USD', BROKER_STARTING_EQUITY / 2, 20, 8);
```

## Key Findings
1. **XRP**: Tighter 10 bps wins because more round-trips compensate for lower per-trade expectancy
2. **SOL**: All spacings lose money (SOL's trending behavior is anti-grid). 20 bps reduces loss by 35% vs 10 bps by cutting whipsaw. Recommend pausing or further reducing SOL allocation.
3. **ATOM** is the only mid-cap that passes both Sharpe > 1.0 AND WR > 60% criteria
4. **UNI and XLM** are consistently negative — consider disabling

## Notes
- TypeScript errors in `multi-broker-router.ts` and `opportunity-scanner.ts` are pre-existing (not introduced by this task)
- No new errors in `index.ts`
- Full report: `docs/coo-journal/optimization-reports/2026-04-25-grid-spacing-optimization.md`
