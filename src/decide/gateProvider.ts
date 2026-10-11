import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { createAnthropicGateClient, type GateConfig, type GateProvider } from './anthropicGateClient.js';
import { createOllamaClient, type OllamaClient } from './ollamaClient.js';

export interface GateWiring {
  client: OllamaClient;
  provider: GateProvider;
  /** The model to call; undefined means "the profile's own local gate model" (the Ollama default). */
  model: string | undefined;
}

/** What main() hands to the pipeline: the chat client the gate calls, and which provider/model it stands for. */
export function buildGateClient(config: GateConfig, anthropic: Pick<Anthropic, 'messages'>, db: Database.Database): GateWiring {
  if (config.provider === 'anthropic') {
    return {
      client: createAnthropicGateClient(anthropic, db, { dailyUsdCap: config.dailyUsdCap }),
      provider: 'anthropic',
      model: config.anthropicModel,
    };
  }
  return { client: createOllamaClient(undefined, db), provider: 'ollama', model: undefined };
}
