import type { PortalAdapter } from "../types.js";

/**
 * Availity Essentials adapter — NOT BUILT YET, on purpose.
 *
 * Selectors written without seeing the live portal would be guesses that fail
 * silently. This gets built after:
 *   1. A dedicated Availity user for us at a pilot practice (Seth/Ryan), with that
 *      practice's consent and a signed BAA with them, Browserbase, and the practice.
 *   2. One recorded walkthrough: login → 2FA → Eligibility & Benefits → patient
 *      search → the benefit-detail page for chiro (STC 33) and behavioral health.
 *   3. A check of Availity's terms on automated access for that account type.
 *
 * Planned flow (same shape as mock.ts):
 *   login(username, password from the practice's encrypted credential)
 *   → 2FA: SMS code to a GHL number, read back by Apps Script, passed in on retry
 *     (return { status: "needs_2fa" } the first time)
 *   → Eligibility & Benefits → payer (params.payerName) → provider NPI
 *     → member ID + DOB → benefit details for params.serviceCodes
 *   → read the label/value pairs → map with a LABELS table → return only params.gaps
 * Browserbase "contexts" can keep the logged-in session between runs to limit 2FA prompts.
 */
export const availityPortal: PortalAdapter = {
  name: "availity",
  async run() {
    return {
      status: "not_implemented",
      fields: {},
      message: "Availity adapter pending a pilot login and recorded walkthrough. See src/portals/availity.ts.",
    };
  },
};
