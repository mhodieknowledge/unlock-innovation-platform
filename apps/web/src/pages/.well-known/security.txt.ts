import type { APIRoute } from "astro";

import { BRAND, CONTACT } from "@mbele/config";

/**
 * security.txt — RFC 9116. PRIVACY_AND_COMPLIANCE.md §11 lists it among the
 * documents published and kept current.
 *
 * A route rather than a static file in public/, because every address and URL in it
 * derives from BRAND.domain, which is a configuration token (PRODUCT_SPEC.md §1). A
 * checked-in copy would carry a stale domain the moment the real one is decided,
 * and a security contact that does not resolve is worse than none at all.
 *
 * Expires is required by the RFC and must be in the future, so it is computed: one
 * year from the build. A file whose Expires has passed is treated as invalid by the
 * tools that read it, and hand-maintained dates are exactly the kind that lapse.
 */
export const prerender = true;

export const GET: APIRoute = () => {
  const expires = new Date();
  expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  expires.setUTCHours(0, 0, 0, 0);

  const body = `# If you have found a vulnerability here, thank you. Tell us and we will fix it.
# There is no bounty — this product has no revenue — but you will get a reply from
# a person, credit if you want it, and no legal threat for looking.

Contact: mailto:${CONTACT.security}
Expires: ${expires.toISOString()}
Preferred-Languages: en
Canonical: https://${BRAND.domain}/.well-known/security.txt
Policy: https://${BRAND.domain}/privacy

# Please do: report anything you find, including in our scheduled jobs and
# database policies — the interesting bugs here are authorisation bugs.
#
# Please don't: run automated scanners against the live site. It runs on free
# infrastructure and a scanner is indistinguishable from an outage for the people
# using it. Ask and we will point you at a copy you can hammer instead.
`;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
};
