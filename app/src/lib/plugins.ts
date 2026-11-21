import type { Plugin } from "@/lib/api";
import { HEXO_CORE_KEYS } from "@/lib/configYaml";

/**
 * Which plugin reads which `_config.yml` key. Most keys are named after their package
 * (`index_generator` → hexo-generator-index); the rest are listed here.
 */
const KNOWN: Record<string, string> = {
  envelope_comment: "hexo-butterfly-envelope",
  // Hexo's own keys that a bundled plugin reads.
  server: "hexo-server",
  deploy: "hexo-deployer-git",
};

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The plugin a config key belongs to: by the table, else the shortest package name holding every word of the key. */
export function pluginForKey(key: string, plugins: Plugin[]): Plugin | null {
  const known = KNOWN[key];
  if (known) return plugins.find((p) => p.name === known) ?? null;
  const want = words(key);
  const found = plugins.filter((p) => {
    const have = words(p.name.replace(/^@[^/]+\//, ""));
    return want.length > 0 && want.every((w) => have.includes(w));
  });
  return found.sort((a, b) => a.name.length - b.name.length)[0] ?? null;
}

export interface PluginView {
  plugin: Plugin;
  /** Its keys in `_config.yml`, in file order. */
  keys: string[];
}

export interface PluginSections {
  /** Installed or listed plugins with their config keys; those with settings first. */
  plugins: PluginView[];
  /** Plugin-looking keys no listed plugin claims (left over, or read by a local script). */
  unclaimed: string[];
}

/** `_config.yml`'s keys grouped by the plugin reading them. */
export function pluginSections(configKeys: string[], plugins: Plugin[]): PluginSections {
  const views = new Map(plugins.map((p) => [p.name, { plugin: p, keys: [] as string[] }]));
  const unclaimed: string[] = [];
  for (const key of configKeys) {
    const owner = pluginForKey(key, plugins);
    if (owner) views.get(owner.name)!.keys.push(key);
    else if (!HEXO_CORE_KEYS.has(key)) unclaimed.push(key);
  }
  const list = [...views.values()];
  return { plugins: [...list.filter((v) => v.keys.length), ...list.filter((v) => !v.keys.length)], unclaimed };
}
