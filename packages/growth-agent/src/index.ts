import { handleRequest } from "./routes";
import type { GrowthAgentEnv } from "./types";

export default {
  fetch(request: Request, env: GrowthAgentEnv): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<GrowthAgentEnv>;
