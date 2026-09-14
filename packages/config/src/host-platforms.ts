/**
 * Host platforms that already have their own teammate finder.
 *
 * TEAM_FORMATION.md's third design move is "Don't fight the host platform" `[PR]`, and
 * §3.1's table says a room on such an opportunity "opens with a link-out banner to the
 * host's tooling". UX_FLOWS.md §10 names the five: Devpost, MLH, HackerEarth, Devfolio,
 * Unstop.
 *
 * Derived from the apply URL rather than stored on the opportunity, because it is a fact
 * about the host and not about the listing — a new Devpost hackathon should not need a
 * human to tick a box for the banner to appear.
 *
 * In config rather than in the page so the batch tier can reach the same judgement: the
 * ingestion pipeline uses it to decide nothing today, but a rule that lives in a template
 * is a rule the next reader duplicates.
 */

export interface HostPlatform {
  /** Registrable host suffix, matched against the URL's hostname. */
  suffix: string;
  name: string;
  /** What the host calls its own teammate feature, in their words. */
  toolName: string;
}

export const HOST_PLATFORMS: readonly HostPlatform[] = [
  { suffix: "devpost.com", name: "Devpost", toolName: "participant list and team finder" },
  { suffix: "mlh.io", name: "MLH", toolName: "team-building channels" },
  { suffix: "hackerearth.com", name: "HackerEarth", toolName: "team invitations" },
  { suffix: "devfolio.co", name: "Devfolio", toolName: "team finder" },
  { suffix: "unstop.com", name: "Unstop", toolName: "team formation tools" },
];

/**
 * The host platform behind a URL, or null.
 *
 * Matches the registrable suffix so `hackathon.devpost.com` and `devpost.com` both
 * resolve, and a look-alike host like `devpost.com.example.invalid` does not.
 */
export function hostPlatformFor(url: string | null | undefined): HostPlatform | null {
  if (!url) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return (
    HOST_PLATFORMS.find(
      (p) => hostname === p.suffix || hostname.endsWith(`.${p.suffix}`),
    ) ?? null
  );
}
