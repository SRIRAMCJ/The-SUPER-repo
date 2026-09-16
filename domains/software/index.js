import { softwareCapabilities } from "./capabilities.js";

export const softwareDomain = Object.freeze({
  id: "software",
  name: "Software Engineering",
  version: "1.0.0",
  description: "Executable capability pack for software engineering analysis and delivery.",
  capabilities: softwareCapabilities
});
