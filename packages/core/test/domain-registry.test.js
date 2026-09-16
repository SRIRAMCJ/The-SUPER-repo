import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityCatalog, DomainRegistry } from "../src/index.js";

test("CapabilityCatalog registers and filters capabilities", () => {
  const catalog = new CapabilityCatalog();
  catalog.register({ id: "software.code-review", version: "1.0.0", domain: "software", kind: "skill", name: "Code Review", description: "Reviews source code" });
  catalog.register({ id: "software.backend", version: "1.0.0", domain: "software", kind: "agent", name: "Backend Engineer", description: "Builds backend systems" });

  assert.equal(catalog.get("software.code-review").name, "Code Review");
  assert.equal(catalog.list({ domain: "software", kind: "skill" }).length, 1);
  assert.throws(() => catalog.register({ id: "software.code-review", version: "1.0.0", domain: "software", kind: "skill", name: "Duplicate", description: "Duplicate" }), /already registered/);
});

test("DomainRegistry requires a registered domain", () => {
  const registry = new DomainRegistry();
  registry.registerDomain({ id: "software", name: "Software", description: "Software engineering" });
  registry.registerCapability({ id: "software.testing", version: "1.0.0", domain: "software", kind: "skill", name: "Testing", description: "Tests software" });

  assert.equal(registry.listDomains().length, 1);
  assert.equal(registry.listCapabilities("software", "skill").length, 1);
  assert.throws(() => registry.registerCapability({ id: "unknown.x", version: "1.0.0", domain: "unknown", kind: "skill", name: "X", description: "X" }), /Unknown capability domain/);
});
