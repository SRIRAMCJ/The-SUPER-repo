import test from "node:test";
import assert from "node:assert/strict";
import { DomainRegistry } from "../src/index.js";
import { softwareDomain } from "../../../domains/software/index.js";

test("software domain registers as a coherent capability pack", () => {
  const registry = new DomainRegistry();
  registry.registerDomain(softwareDomain);
  for (const capability of softwareDomain.capabilities) registry.registerCapability(capability);

  assert.equal(registry.getDomain("software").name, "Software Engineering");
  assert.equal(registry.listCapabilities("software").length, 4);
  assert.equal(registry.listCapabilities("software", "skill").length, 3);
  assert.ok(registry.capabilities.has("software.repository-analysis"));
});
