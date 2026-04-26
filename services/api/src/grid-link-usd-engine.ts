/**
 * LINK-USD Grid Trading Engine on Coinbase
 *
 * Chainlink is a high-beta crypto with distinct action from BTC/ETH.
 * Running a tight grid to capture mean-reversion around rallies.
 */

import { GridEngine } from './grid-engine.js';

const LINK_GRID_SPACING_BPS = 12;
const LINK_NUM_LEVELS = 10;
const LINK_POSITION_SIZE_FRACTION = 0.03;
const LINK_RECENTER_THRESHOLD = 0.05;

export function createLinkGrid(startingEquity: number): GridEngine {
  const grid = new GridEngine('LINK-USD', startingEquity, LINK_GRID_SPACING_BPS, LINK_NUM_LEVELS);
  grid.allocationMultiplier = 1.0;
  return grid;
}
