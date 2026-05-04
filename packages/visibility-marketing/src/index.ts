import { callGrowthAgent } from "./client";
import type { MarketingEnv } from "./types";

export default {
  async fetch(request: Request, env: MarketingEnv): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.json();
    const tenantId = request.headers.get("x-tenant-id") ?? "unknown";
    const correlationId = request.headers.get("x-correlation-id") ?? `${tenantId}:${crypto.randomUUID()}`;
    const result = await callGrowthAgent({
      env,
      capability: "growth-next-action",
      tenantId,
      correlationId,
      payload: body,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  },
};
