import { describe, expect, it } from "vitest";
import { jsonEdits } from "./dataJson";

const EXTRA = '{\n  "watchedExtra": [\n    {\n      "title": "缘之空",\n      "id": 0\n    }\n  ]\n}\n';

describe("jsonEdits", () => {
  it("writes back in the file's indent and keeps key order", () => {
    // Act
    const out = jsonEdits.setValue(EXTRA, ["watchedExtra", 0, "title"], "缘之空 2");

    // Assert
    expect(out).toBe(EXTRA.replace('"缘之空"', '"缘之空 2"'));
  });

  it("keeps a one-line file on one line", () => {
    // Act
    const out = jsonEdits.appendItem('{"a":[1]}', ["a"], 2);

    // Assert
    expect(out).toBe('{"a":[1,2]}');
  });

  it("adds, removes and renames", () => {
    // Act
    const added = jsonEdits.appendItem(EXTRA, ["watchedExtra"], { title: "", id: 0 });
    const removed = jsonEdits.removeItem(added, ["watchedExtra"], 1);
    const renamed = jsonEdits.renameKey(EXTRA, ["watchedExtra", 0, "id"], "uid");

    // Assert
    expect(JSON.parse(added).watchedExtra).toHaveLength(2);
    expect(removed).toBe(EXTRA);
    expect(Object.keys(JSON.parse(renamed).watchedExtra[0])).toEqual(["title", "uid"]);
    expect(() => jsonEdits.setValue("{", ["a"], 1)).toThrow();
  });
});
