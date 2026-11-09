// Stedi Real-Time Eligibility (270/271) client — redesigned JSON endpoint.
// No dependencies (Node 18+ global fetch). Works in Supabase Edge Functions (Deno) too.
//
// Auth: test keys only accept Stedi's predefined mock requests; production keys send real checks.

export const STEDI_ELIGIBILITY_URL = 'https://healthcare.us.stedi.com/2026-06-01/eligibility-check';

// HTTP statuses that never produced a payer answer — safe to retry.
const RETRYABLE_HTTP = new Set([429, 502, 503, 504]);
// AAA 42 = payer temporarily unable to respond ("Resubmission Allowed").
// Not 79: Stedi returns 79 (invalid participant / wrong payer ID) as HTTP 400, so retrying can't fix it.
const RETRYABLE_AAA = new Set(['42']);

/**
 * Build a request body for the 2026-06-01 endpoint.
 * dob must be YYYY-MM-DD. serviceCodes are STCs, e.g. ['33'] for chiro.
 */
export function buildEligibilityRequest({ payerId, providerName, npi, firstName, lastName, dob, memberId, serviceCodes = ['30'], dependent }) {
  const body = {
    payerId,
    provider: { name: { organization: providerName }, npi },
    subscriber: {
      name: { person: { firstName, lastName } },
      dateOfBirth: dob,
      ...(memberId ? { memberId } : {}),
    },
    // Stedi recommends one STC per request; callers loop if they need several.
    encounter: { services: serviceCodes.slice(0, 1).map((value) => ({ system: 'STC', value })) },
  };
  if (dependent) {
    body.dependents = [{
      name: { person: { firstName: dependent.firstName, lastName: dependent.lastName } },
      dateOfBirth: dependent.dob,
    }];
  }
  return body;
}

/**
 * Send one eligibility check with retries for payer/connection outages.
 * Returns { ok, httpStatus, body, tries, elapsedMs }. Never throws on payer errors,
 * so the caller's normalizer can classify them.
 */
export async function checkEligibility(body, {
  apiKey = globalThis.process?.env?.STEDI_API_KEY ?? globalThis.Deno?.env.get('STEDI_API_KEY'),
  timeoutMs = 70_000,        // payers can take up to ~60 s
  retryWindowMs = 120_000,   // Stedi guidance: keep retrying outages for up to ~2 min
  url = STEDI_ELIGIBILITY_URL,
} = {}) {
  if (!apiKey) throw new Error('STEDI_API_KEY is not set');
  const started = Date.now();
  let tries = 0;
  let last;

  while (true) {
    tries += 1;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = { rawText: text }; }
      last = { ok: res.ok, httpStatus: res.status, body: json, retryAfter: res.headers.get('retry-after') };

      const aaa = (json?.errors ?? []).map((e) => String(e.code));
      const retryable = RETRYABLE_HTTP.has(res.status) || res.status >= 500 || aaa.some((c) => RETRYABLE_AAA.has(c));
      if (!retryable) break;
    } catch (err) {
      last = { ok: false, httpStatus: 0, body: { networkError: String(err?.message ?? err) } };
    }

    const elapsed = Date.now() - started;
    if (elapsed >= retryWindowMs) break;
    const backoff = last?.retryAfter ? Number(last.retryAfter) * 1000 : Math.min(2 ** tries * 1000, 20_000);
    await new Promise((r) => setTimeout(r, Math.min(backoff, retryWindowMs - elapsed)));
  }

  const { retryAfter, ...result } = last;
  return { ...result, tries, elapsedMs: Date.now() - started };
}
