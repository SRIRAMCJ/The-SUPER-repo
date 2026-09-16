import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

test("capability manifest schema declares executable capability kinds", async () => {
  const schema = JSON.parse(await readFile(join(here, "../..", "schemas/capability-manifest.schema.json"), "utf8"));
  assert.deepEqual(schema.required, ["id", "version", "domain", "kind", "name", "description"]);
  assert.deepEqual(schema.properties.kind.enum, ["agent", "skill", "command", "tool", "workflow", "team", "template", "example", "benchmark"]);
  assert.equal(schema.additionalProperties, false);
});
