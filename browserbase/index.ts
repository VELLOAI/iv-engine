/**
 * Browserbase Function: iv-portal-benefits
 *
 * Stage 2 of the IV engine. Apps Script invokes it with the verification's open gaps;
 * it logs into the payer portal in a Browserbase browser, reads only those fields, and
 * returns them. Apps Script writes the fields to Supabase and decides the next stage.
 *
 * Deterministic Playwright: no LLM sees patient data.
 */
import { defineFn } from "@browserbasehq/sdk-functions";
import { chromium } from "playwright-core";
import { z } from "zod";
import { FIELD_KEYS, type PortalParams } from "./src/types.js";
import { runPortal } from "./src/run.js";

const Params = z.object({
  portal: z.enum(["mock", "availity", "payer_portal"]),
  payerId: z.string(),
  payerName: z.string().optional(),
  providerNpi: z.string().regex(/^\d{10}$/),
  patient: z.object({
    firstName: z.string(), lastName: z.string(),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), memberId: z.string().optional(),
  }),
  serviceCodes: z.array(z.string()).min(1),
  gaps: z.array(z.enum(FIELD_KEYS)).min(1),
  verificationId: z.string().optional(),
});

defineFn(
  "iv-portal-benefits",
  async (context, params) => {
    const browser = await chromium.connectOverCDP(context.session.connectUrl);
    try {
      const page = browser.contexts()[0]!.pages()[0]!;
      const result = await runPortal(page, params as PortalParams, context.secrets ?? {});
      return { ...result, sessionId: context.session.id } as unknown as Record<string, never>;
    } finally {
      await browser.close();
    }
  },
  {
    parametersSchema: Params,
    sessionConfig: {
      api_timeout: 300, // seconds; Functions allow 60–900
      // Portal screens show patient data: don't record or log the session.
      browserSettings: { recordSession: false, logSession: false },
    },
  },
);
