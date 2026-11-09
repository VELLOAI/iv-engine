import type { Page } from "playwright-core";

/** Same field keys as apps-script/Normalize.js FIELD_KEYS — the contract every stage shares. */
export const FIELD_KEYS = [
  "coverage_active", "plan_name", "network_status", "copay", "coinsurance",
  "deductible_total", "deductible_remaining", "oop_max_total", "oop_remaining",
  "visit_limit", "prior_auth_required",
  "group_number", "plan_start", "visits_used", "carve_out_vendor", "payer_messages",
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export interface PortalParams {
  portal: "mock" | "availity" | "payer_portal";
  payerId: string;
  payerName?: string;
  providerNpi: string;
  patient: { firstName: string; lastName: string; dob: string; memberId?: string };
  serviceCodes: string[];      // STCs, e.g. ["33"]
  gaps: FieldKey[];            // only these are looked up and returned
  verificationId?: string;     // for logs only — never navigated to or typed anywhere
}

export interface FieldResult { value: string | number | boolean | string[]; evidence?: string }

export interface PortalResult {
  status: "ok" | "not_found" | "login_failed" | "needs_2fa" | "not_implemented" | "error";
  fields: Partial<Record<FieldKey, FieldResult>>;
  message?: string;
}

export interface PortalAdapter {
  name: string;
  run(page: Page, params: PortalParams, secrets: Record<string, string>): Promise<PortalResult>;
}

/** "$1,500.00" → 1500 · "20%" → 20 · "Yes" → true · otherwise trimmed string */
export function parseValue(raw: string): string | number | boolean {
  const s = raw.trim();
  if (/^(yes|required|true)$/i.test(s)) return true;
  if (/^(no|not required|false)$/i.test(s)) return false;
  const money = s.match(/^\$?\s*([\d,]+(?:\.\d+)?)\s*%?$/);
  if (money) return Number(money[1].replace(/,/g, ""));
  return s;
}
