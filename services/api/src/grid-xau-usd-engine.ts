/**
 * XAU-USD Grid Trading Engine on OANDA
 *
 * Gold in USD — excellent non-crypto diversifier.
 * Gold is mean-reverting at longer timeframes with clear support/resistance.
 * Running a moderately tight grid to capture range-bound action.
 */

import { GridEngine } from './grid-engine.js';

const XAU_GRID_SPACING_BPS = 15;
const XAU_NUM_LEVELS = 8;
const XAU_POSITION_SIZE_FRACTION = 0.04;
const XAU_RECENTER_THRESHOLD = 0.03;

export function createXauGrid(startingEquity: number): GridEngine {
  const grid = new GridEngine('XAU_USD', startingEquity, XAU_GRID_SPACING_BPS, XAU_NUM_LEVELS);
  grid.allocationMultiplier = 1.0;
  return grid;
}
