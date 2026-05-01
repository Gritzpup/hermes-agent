/**
 * Kimi API client for the COO bridge.
 * Uses OAuth authentication via Kimi CLI's credentials.
 * 
 * For kimi-for-coding access, OAuth is required as API keys are rejected.
 * This client reads the OAuth token from Kimi CLI's credential store.
 */

import { logger } from '@hermes/logger';
import { KIMI_MODEL } from './config.js';

// Re-export chatCompletion from the OAuth client
export { chatCompletion, type ChatMessage } from './kimi-client-oauth.js';
