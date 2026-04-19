/**
 * Engine Context Interface
 *
 * Defines the shape of the PaperScalpingEngine instance that extracted
 * functions need access to. This avoids importing the full engine class
 * and prevents circular dependencies.
 */
import { STARTING_EQUITY, FILL_LEDGER_PATH, BROKER_ROUTER_URL } from './types.js';
