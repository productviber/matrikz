import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/constants";
import { PROMPT_REGISTRY as NextActionPrompts } from "../../src/capabilities/growthNextAction";
import { PROMPT_REGISTRY as SummarizePrompts } from "../../src/capabilities/growthSignalSummarize";
import { PROMPT_REGISTRY as JourneyPrompts } from "../../src/capabilities/journeyCritic";
import { PROMPT_REGISTRY as BriefPrompts } from "../../src/capabilities/messageBrief";
import { PROMPT_REGISTRY as DiagnosePrompts } from "../../src/capabilities/outcomeDiagnose";

const registries = [
  NextActionPrompts,
  SummarizePrompts,
  JourneyPrompts,
  BriefPrompts,
  DiagnosePrompts,
];

describe("prompt version and schema version sync", () => {
  it("keeps current prompt semver aligned with response schema semver", () => {
    for (const registry of registries) {
      const version = registry.current.version;
      const semver = version.slice(version.lastIndexOf("-") + 1);
      expect(semver).toBe(DEFAULTS.responseSchemaVersion);
    }
  });
});
