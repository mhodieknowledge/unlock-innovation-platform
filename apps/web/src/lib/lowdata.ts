/**
 * Low-data mode. DESIGN_SYSTEM.md §10, SYSTEM_ARCHITECTURE.md §3.4, PRODUCT_SPEC.md §25.2.
 *
 * "Cookie `ld=1`, also set automatically when `Save-Data: on` is present, READ SERVER-SIDE so
 * the first paint is already light." That last clause is the whole design: a mode applied by
 * a script after the page arrives has already cost the reader the bytes it exists to save.
 *
 * Three inputs, in priority order:
 *   1. The cookie, because it is the reader's explicit choice on this device.
 *   2. The `Save-Data: on` header, because a reader who set it at the OS level has already
 *      said what they want and should not have to say it again here.
 *   3. The signed-in account preference, which follows them to a new device.
 *
 * §10's target is an opportunity list page under 40 KB. At Zimbabwe's mobile data prices that
 * is roughly a tenth of a US cent a page against about nine cents for a typical 2 MB web app
 * — the difference between a product people can afford to browse and one they cannot.
 */

import type { AstroCookies } from "astro";

export const LOW_DATA_COOKIE = "ld";

export interface LowDataInputs {
  cookies: AstroCookies;
  request: Request;
  /** The signed-in account's preference, when the page has already loaded a session. */
  accountPreference?: boolean | null;
}

export interface LowDataState {
  on: boolean;
  /** Which input decided it, so the footer line can say something true about the toggle. */
  source: "cookie" | "header" | "account" | "default";
}

export function resolveLowData({
  cookies,
  request,
  accountPreference = null,
}: LowDataInputs): LowDataState {
  const cookie = cookies.get(LOW_DATA_COOKIE)?.value;
  // An explicit "0" turns it off even when Save-Data is on: the reader's choice on this
  // device is the most specific signal there is, in both directions.
  if (cookie === "1") return { on: true, source: "cookie" };
  if (cookie === "0") return { on: false, source: "cookie" };

  const saveData = request.headers.get("save-data");
  if (saveData && /\bon\b/i.test(saveData)) return { on: true, source: "header" };

  if (accountPreference === true) return { on: true, source: "account" };

  return { on: false, source: "default" };
}

/**
 * Persist the choice for a year.
 *
 * Essential, in the sense PRIVACY_AND_COMPLIANCE.md §1 uses: without it the first paint of
 * the next page is heavy, which is the one thing this mode exists to prevent. That is why the
 * privacy page can say there are two cookies and no consent banner.
 */
export function setLowDataCookie(cookies: AstroCookies, on: boolean): void {
  cookies.set(LOW_DATA_COOKIE, on ? "1" : "0", {
    path: "/",
    httpOnly: false,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/**
 * A two-letter monogram, for the logo that is not being loaded. §10: "replaced by a
 * two-letter monogram in `--sunken` with `--ink-2` text, rendered in CSS."
 *
 * Initials from word starts, so "Kumasi Hive" reads KH rather than KU — the point is to be
 * distinguishable at a glance from the organisation beside it.
 */
export function monogram(name: string | null | undefined): string {
  const words = (name ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
