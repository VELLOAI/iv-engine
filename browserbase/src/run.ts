import type { Page } from "playwright-core";
import type { PortalAdapter, PortalParams, PortalResult } from "./types.js";
import { mockPortal } from "./portals/mock.js";
import { availityPortal } from "./portals/availity.js";

const ADAPTERS: Record<string, PortalAdapter> = { mock: mockPortal, availity: availityPortal };

export async function runPortal(page: Page, params: PortalParams, secrets: Record<string, string>): Promise<PortalResult> {
  const adapter = ADAPTERS[params.portal];
  if (!adapter) return { status: "not_implemented", fields: {}, message: `No adapter for portal "${params.portal}"` };
  try {
    return await adapter.run(page, params, secrets);
  } catch (err) {
    // Never echo page content or patient data into the error.
    return { status: "error", fields: {}, message: `${adapter.name}: ${(err as Error).name}: ${(err as Error).message.split("\n")[0]}` };
  }
}
