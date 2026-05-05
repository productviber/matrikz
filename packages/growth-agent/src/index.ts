import { handleRequest } from "./routes";
import type { GrowthAgentEnv } from "./types";
import { getRuntimeConfig } from "./types";
import { runProactiveScanJob } from "./proactiveScan/proactiveScanJob";
import { WorkersAiAdapter } from "./llm/workersAiAdapter";
import { FetchLlmAdapter } from "./llm/fetchLlmAdapter";
import { FailoverLlmAdapter } from "./llm/failoverLlmAdapter";
import { cleanupRetentionData } from "./observability/retention";

export default {
  fetch(request: Request, env: GrowthAgentEnv): Promise<Response> {
    return handleRequest(request, env);
  },

  async scheduled(_controller: ScheduledController, env: GrowthAgentEnv): Promise<void> {
    const config = getRuntimeConfig(env);

    if (config.proactiveScanEnabled) {
      const primary = new WorkersAiAdapter(env);
      const llm = env.SECONDARY_LLM_PROVIDER_URL && env.SECONDARY_LLM_PROVIDER_API_KEY
        ? new FailoverLlmAdapter(
            primary,
            new FetchLlmAdapter(env.SECONDARY_LLM_PROVIDER_URL, env.SECONDARY_LLM_PROVIDER_API_KEY),
          )
        : primary;
      await runProactiveScanJob(env, { llm, config });
    }

    await cleanupRetentionData(env, config.outcomeRetentionDays);

    if (env.TENANT_PRIOR_KV) {
      const stalePriorSample = await env.TENANT_PRIOR_KV.list({ prefix: "prior:" });
      if (stalePriorSample.keys.length === 0) {
        console.log(JSON.stringify({ type: "stale_prior_warning", message: "no_tenant_priors_found" }));
      }
    }

    if (env.INTERNAL_SECRET_ROLLOVER) {
      console.log(
        JSON.stringify({
          type: "stale_rotation_secret",
          message:
            "INTERNAL_SECRET_ROLLOVER is still set — remove after rotation window expires",
          rotationWindowHours: env.INTERNAL_SECRET_ROTATION_WINDOW_HOURS ?? "24",
        }),
      );
    }
  },
} satisfies ExportedHandler<GrowthAgentEnv>;
