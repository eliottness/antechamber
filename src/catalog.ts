/**
 * Model/provider catalog: obtained from a throwaway `pi --mode rpc` process
 * (`get_available_models` + `get_state`), translated into OpenCode v2
 * Provider/Model shapes, refreshed from live agents or bounded cold reads.
 */

import { PiRpcClient } from "./pi-rpc.js";
import { thinkingVariants, type ThinkingModel } from "./thinking-levels.js";

interface PiModelInfo extends ThinkingModel {
  id: string;
  provider: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface OCv2Model {
  id: string;
  providerID: string;
  api: { id: string; url: string; npm: string };
  name: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    interleaved: boolean;
  };
  cost: { input: number; output: number; cache: { read: number; write: number } };
  limit: { context: number; output: number };
  options: Record<string, unknown>;
  variants?: Record<string, Record<string, unknown>>;
}

interface OCv2Provider {
  id: string;
  name: string;
  source: "config";
  env: string[];
  options: Record<string, unknown>;
  models: Record<string, OCv2Model>;
}

export interface Catalog {
  providers: OCv2Provider[];
  /** providerID → default modelID */
  defaults: Record<string, string>;
  /**
   * The model pi reported as *active*. Separate from `defaults` because the
   * client pins its picker to /api/model/default and then validates it against
   * the catalog — an arbitrary pick here silently becomes the model the UI
   * believes is running.
   */
  default?: { providerID: string; modelID: string };
  /** pi's resolved thinking level for `default` (its per-model setting). */
  defaultThinkingLevel?: string;
}

/**
 * OpenChamber preselects an agent's `model` + `variant` for new sessions; publish
 * pi's active model and its resolved thinking level so "Default" is pi's level.
 */
export function agentDefaults(cat: Catalog): { model?: { providerID: string; modelID: string }; variant?: string } {
  if (cat.default === undefined) return {};
  return cat.defaultThinkingLevel !== undefined
    ? { model: cat.default, variant: cat.defaultThinkingLevel }
    : { model: cat.default };
}

function toOCModel(m: PiModelInfo): OCv2Model {
  const inputs = new Set(m.input ?? ["text"]);
  const modality = (name: string): boolean => inputs.has(name);
  const variants = thinkingVariants(m);
  return {
    id: m.id,
    providerID: m.provider,
    api: { id: m.id, url: m.baseUrl ?? "", npm: "@ai-sdk/openai-compatible" },
    name: m.name ?? m.id,
    capabilities: {
      temperature: true,
      reasoning: m.reasoning ?? false,
      attachment: modality("image"),
      toolcall: true,
      input: { text: modality("text"), audio: false, image: modality("image"), video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: !!m.reasoning,
    },
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cache: { read: m.cost?.cacheRead ?? 0, write: m.cost?.cacheWrite ?? 0 },
    },
    limit: { context: m.contextWindow ?? 0, output: m.maxTokens ?? 0 },
    options: {},
    ...(variants !== undefined ? { variants } : {}),
  };
}

type PiState = { model: PiModelInfo | null; thinkingLevel?: string };

function inventory(res: { success: boolean; data?: { models: PiModelInfo[] } }): Map<string, OCv2Provider> {
  const providers = new Map<string, OCv2Provider>();
  if (res.success && res.data) {
    for (const m of res.data.models) {
      let p = providers.get(m.provider);
      if (!p) {
        p = { id: m.provider, name: m.provider, source: "config", env: [], options: {}, models: {} };
        providers.set(m.provider, p);
      }
      p.models[m.id] = toOCModel(m);
    }
  }
  return providers;
}

/**
 * Apply the default to the inventory: list it even if get_available_models omitted it (the client drops a
 * selection it cannot find), and put it first, because OpenChamber's picker defaults to the first listed
 * provider/model. `active` is a model from a fresh agent's get_state, or the previous snapshot's default.
 */
function withDefault(
  providers: Map<string, OCv2Provider>,
  active: { providerID: string; modelID: string; model: OCv2Model } | null,
  thinkingLevel: string | undefined,
): Catalog {
  const defaults: Record<string, string> = {};
  if (active !== null) {
    defaults[active.providerID] = active.modelID;
    let p = providers.get(active.providerID);
    if (p === undefined) {
      p = { id: active.providerID, name: active.providerID, source: "config", env: [], options: {}, models: {} };
      providers.set(active.providerID, p);
    }
    if (p.models[active.modelID] === undefined) p.models[active.modelID] = active.model;
  }
  const sorted = [...providers.values()].sort((a, b) => {
    const aDef = defaults[a.id] !== undefined ? 0 : 1;
    const bDef = defaults[b.id] !== undefined ? 0 : 1;
    return aDef - bDef;
  });
  for (const p of sorted) {
    const def = defaults[p.id];
    if (!def) continue;
    const entries = Object.entries(p.models).sort(([a], [b]) => (a === def ? -1 : b === def ? 1 : 0));
    p.models = Object.fromEntries(entries);
  }
  // exactOptionalPropertyTypes: omit `default` rather than set it undefined.
  if (active === null) return { providers: sorted, defaults };
  const resolvedDefault = { providerID: active.providerID, modelID: active.modelID };
  // Only a level the catalog offers as a variant is selectable in the picker.
  const offered = sorted.find((p) => p.id === active.providerID)?.models[active.modelID]?.variants;
  return thinkingLevel !== undefined && offered?.[thinkingLevel] !== undefined
    ? { providers: sorted, defaults, default: resolvedDefault, defaultThinkingLevel: thinkingLevel }
    : { providers: sorted, defaults, default: resolvedDefault };
}

/**
 * The configured default plus the provider/model inventory in a fixed order, so a reordering alone is not
 * reported as a catalog change but a new default is.
 */
export function catalogFingerprint(catalog: Catalog): string {
  return JSON.stringify([
    catalog.default ?? null,
    catalog.defaultThinkingLevel ?? null,
    [...catalog.providers]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => [
        p.id,
        Object.keys(p.models)
          .sort()
          .map((id) => [id, p.models[id]]),
      ]),
  ]);
}

/**
 * `configured` is the previous snapshot when `client` is a live session's agent: that agent's `get_state.model`
 * is the session's own selection, not the configured default, so only the model inventory is re-read and the
 * snapshot's default is kept. Only a fresh `--no-session` agent defines the default.
 */
export async function loadCatalog(directory: string, client?: PiRpcClient, configured?: Catalog): Promise<Catalog> {
  const pi = client ?? new PiRpcClient({ cwd: directory, args: ["--no-session"] });
  try {
    if (configured !== undefined) {
      const modelsRes = await pi.command<{ models: PiModelInfo[] }>({ type: "get_available_models" });
      const def = configured.default;
      const model = def && configured.providers.find((p) => p.id === def.providerID)?.models[def.modelID];
      return withDefault(
        inventory(modelsRes),
        def && model ? { ...def, model } : null,
        configured.defaultThinkingLevel,
      );
    }
    const [modelsRes, firstState] = await Promise.all([
      pi.command<{ models: PiModelInfo[] }>({ type: "get_available_models" }),
      pi.command<PiState>({ type: "get_state" }),
    ]);
    // get_state occasionally races pi's own startup. One retry beats resolving
    // no active model, which is precisely what leaves the UI picker guessing.
    let active = firstState.success ? (firstState.data?.model ?? null) : null;
    let thinkingLevel = firstState.success ? firstState.data?.thinkingLevel : undefined;
    if (active === null) {
      const retry = await pi.command<PiState>({ type: "get_state" });
      active = retry.success ? (retry.data?.model ?? null) : null;
      thinkingLevel = retry.success ? retry.data?.thinkingLevel : undefined;
    }
    if (active === null) {
      console.error(
        "[catalog] warning: pi reported no active model — /api/model/default will be null and the UI picker falls back to its own default",
      );
    }
    return withDefault(
      inventory(modelsRes),
      active === null ? null : { providerID: active.provider, modelID: active.id, model: toOCModel(active) },
      thinkingLevel,
    );
  } finally {
    if (client === undefined) await pi.dispose();
  }
}
