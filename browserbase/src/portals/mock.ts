import type { Page } from "playwright-core";
import { parseValue, type FieldKey, type PortalAdapter, type PortalResult } from "../types.js";

/**
 * Mock payer portal, rendered inside the real Browserbase browser with page.setContent().
 * It exercises the same steps a real portal needs: log in → search a member → read a
 * benefits table by its labels. No network, no PHI. Only Stedi's mock member UHC123456
 * returns benefits; any other member gets "No eligibility found".
 */

const MOCK_BENEFITS: Record<string, Record<string, string>> = {
  UHC123456: {
    "Plan": "Gold Plan HMO",
    "Chiropractic visit limit": "20 visits per calendar year",
    "Chiropractic visits used": "6",
    "Deductible (individual, in-network)": "$1,500.00",
    "Deductible remaining": "$0.00",
    "Prior authorization required": "No",
    "Chiropractic copay": "$15.00",
  },
};

// Portal label → engine field key. Real adapters keep a map like this per portal.
const LABELS: Record<string, FieldKey> = {
  "Plan": "plan_name",
  "Chiropractic visit limit": "visit_limit",
  "Chiropractic visits used": "visits_used",
  "Deductible (individual, in-network)": "deductible_total",
  "Deductible remaining": "deductible_remaining",
  "Prior authorization required": "prior_auth_required",
  "Chiropractic copay": "copay",
};

const html = (benefits: typeof MOCK_BENEFITS) => `<!doctype html><html><head><title>Mock Payer Portal</title>
<style>body{font-family:sans-serif;margin:40px} .hidden{display:none} th{text-align:left;padding-right:24px}</style></head>
<body>
<h1>Mock Payer Portal</h1>
<form id="login"><input id="username" placeholder="Username"><input id="password" type="password" placeholder="Password">
<button id="signin" type="submit">Sign in</button><p id="login-error" class="hidden">Invalid credentials</p></form>
<form id="search" class="hidden"><h2>Eligibility &amp; Benefits</h2>
<input id="member-id" placeholder="Member ID"><input id="dob" placeholder="YYYY-MM-DD"><button id="find" type="submit">Search</button></form>
<div id="results" class="hidden"></div>
<script>
const DATA = ${JSON.stringify(benefits)};
document.getElementById('login').onsubmit = e => { e.preventDefault();
  const ok = document.getElementById('username').value === 'mock' && document.getElementById('password').value === 'mock';
  document.getElementById('login-error').classList.toggle('hidden', ok);
  if (ok) { document.getElementById('login').classList.add('hidden'); document.getElementById('search').classList.remove('hidden'); } };
document.getElementById('search').onsubmit = e => { e.preventDefault();
  setTimeout(() => { const r = document.getElementById('results'); const b = DATA[document.getElementById('member-id').value.trim()];
    r.innerHTML = b ? '<table id="benefits">' + Object.entries(b).map(([k,v]) => '<tr><th>'+k+'</th><td>'+v+'</td></tr>').join('') + '</table>'
                    : '<p id="no-results">No eligibility found</p>';
    r.classList.remove('hidden'); }, 400); };
</script></body></html>`;

export const mockPortal: PortalAdapter = {
  name: "mock",
  async run(page: Page, params, secrets): Promise<PortalResult> {
    await page.setContent(html(MOCK_BENEFITS));

    // 1. Login (a real adapter reads per-practice credentials; the mock accepts mock/mock)
    await page.fill("#username", secrets.MOCK_PORTAL_USER ?? "mock");
    await page.fill("#password", secrets.MOCK_PORTAL_PASSWORD ?? "mock");
    await page.click("#signin");
    if (await page.isVisible("#login-error")) return { status: "login_failed", fields: {} };

    // 2. Member search
    await page.fill("#member-id", params.patient.memberId ?? "");
    await page.fill("#dob", params.patient.dob);
    await page.click("#find");
    await page.waitForSelector("#benefits, #no-results", { timeout: 15_000 });
    if (await page.isVisible("#no-results")) return { status: "not_found", fields: {}, message: "Portal: no eligibility found" };

    // 3. Read the benefits table by label; return only the gaps we were asked for
    const rows = await page.$$eval("#benefits tr", (trs) =>
      trs.map((tr) => [tr.querySelector("th")?.textContent ?? "", tr.querySelector("td")?.textContent ?? ""] as [string, string]));
    const fields: PortalResult["fields"] = {};
    for (const [label, raw] of rows) {
      const key = LABELS[label.trim()];
      if (!key || !params.gaps.includes(key)) continue;
      const value = key === "visit_limit" || key === "visits_used"
        ? Number((raw.match(/\d+/) ?? [raw])[0])
        : parseValue(raw);
      fields[key] = { value, evidence: `Mock portal: ${label.trim()} = ${raw.trim()}` };
    }
    return { status: "ok", fields };
  },
};
