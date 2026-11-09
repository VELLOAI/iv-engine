/**
 * Runs the portal adapters in a local Chrome (no Browserbase account needed).
 *   CHROME_PATH=/path/to/chrome npm run test:local
 * Default path is macOS Google Chrome.
 */
import { chromium } from "playwright-core";
import { runPortal } from "../src/run.js";
import type { PortalParams } from "../src/types.js";

const executablePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const base: Omit<PortalParams, "patient"> = {
  portal: "mock", payerId: "87726", payerName: "UnitedHealthcare", providerNpi: "1999999984",
  serviceCodes: ["33"], gaps: ["deductible_total", "visit_limit", "prior_auth_required"],
};

const cases: [string, PortalParams][] = [
  ["mock: Stedi gaps for UHC123456", { ...base, patient: { firstName: "Jane", lastName: "Doe", dob: "1971-01-01", memberId: "UHC123456" } }],
  ["mock: unknown member", { ...base, patient: { firstName: "John", lastName: "Roe", dob: "1980-02-02", memberId: "NOPE999" } }],
  ["availity: not built yet", { ...base, portal: "availity", patient: { firstName: "Jane", lastName: "Doe", dob: "1971-01-01", memberId: "UHC123456" } }],
];

const browser = await chromium.launch({ executablePath, headless: true });
let failed = 0;
for (const [name, params] of cases) {
  const page = await (await browser.newContext()).newPage();
  const r = await runPortal(page, params, {});
  console.log(`■ ${name}\n  ${JSON.stringify(r)}`);
  if (name.startsWith("mock: Stedi") && !(r.status === "ok" && r.fields.visit_limit?.value === 20 && r.fields.deductible_total?.value === 1500 && r.fields.prior_auth_required?.value === false)) failed++;
  if (name.startsWith("mock: unknown") && r.status !== "not_found") failed++;
  if (name.startsWith("availity") && r.status !== "not_implemented") failed++;
}
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
