import { getIn, setIn, type Path } from "@/lib/configYaml";

/**
 * Page data kept as JSON (`extra_bangumis.json`): edited as values and written back whole, in
 * the file's own indent (or on one line when it was written so). JSON has no comments or
 * quoting choices to keep, so this loses nothing.
 */

function layout(text: string): { indent: string | number; newline: boolean } {
  const m = /\n([ \t]+)\S/.exec(text);
  return { indent: m ? (m[1].startsWith("\t") ? "\t" : m[1].length) : 0, newline: text.endsWith("\n") };
}

function rewrite(text: string, change: (data: unknown) => unknown): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 有语法错误：${(e as Error).message}`);
  }
  const { indent, newline } = layout(text);
  return JSON.stringify(change(data), null, indent) + (newline ? "\n" : "");
}

const parentOf = (path: Path) => path.slice(0, -1);
const last = (path: Path) => path[path.length - 1];

export const jsonEdits = {
  setValue: (text: string, path: Path, value: unknown) => rewrite(text, (d) => setIn(d, path, value)),
  appendItem: (text: string, path: Path, value: unknown) =>
    rewrite(text, (d) => {
      const list = getIn(d, path);
      return setIn(d, path, [...(Array.isArray(list) ? list : []), value]);
    }),
  removeItem: (text: string, path: Path, index: number) => rewrite(text, (d) => setIn(d, path, (getIn(d, path) as unknown[]).filter((_, i) => i !== index))),
  removeKey: (text: string, path: Path) =>
    rewrite(text, (d) => {
      const parent = getIn(d, parentOf(path)) as Record<string, unknown>;
      return setIn(d, parentOf(path), Object.fromEntries(Object.entries(parent).filter(([k]) => k !== last(path))));
    }),
  renameKey: (text: string, path: Path, name: string) =>
    rewrite(text, (d) => {
      const parent = getIn(d, parentOf(path)) as Record<string, unknown>;
      if (name in parent && name !== last(path)) throw new Error(`已经有一项叫「${name}」`);
      return setIn(d, parentOf(path), Object.fromEntries(Object.entries(parent).map(([k, v]) => [k === last(path) ? name : k, v])));
    }),
};
