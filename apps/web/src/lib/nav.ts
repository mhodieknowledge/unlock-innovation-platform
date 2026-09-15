/**
 * The primary navigation, defined once.
 *
 * DESIGN_SYSTEM.md §5.7 gives mobile and desktop different shapes — a bottom bar and a
 * top bar — and §9 says "Mobile is designed first and independently, not derived by
 * shrinking the desktop layout". Different shapes, same destinations: two hand-maintained
 * lists is how a product ends up with a tab the desktop header has never heard of.
 *
 * DEVIATION FROM §5.7, recorded rather than quietly taken. The section names the five as
 * "Board · Search · Tracker · Rooms · You". `Rooms` is replaced by `Categories` here.
 * Rooms are per-opportunity (`/opportunities/[slug]/room`) and have no index to link to,
 * so the tab would have pointed at a browse surface that is not what it says; categories
 * are one of the two axes this catalogue is actually organised by, and the reader who
 * wants a scholarship rather than a hackathon has no other way to say so on a phone.
 */

export interface NavItem {
  label: string;
  href: string;
  /** Matches the Icon component's names. */
  icon: "board" | "search" | "categories" | "tracker" | "you" | "globe";
  /** Signed-out readers are most of the traffic; a tab they cannot use is a dead tab. */
  signedInOnly?: boolean;
}

/** The five that appear in the mobile bottom bar, in order. */
export const PRIMARY_NAV: NavItem[] = [
  { label: "Board", href: "/", icon: "board" },
  { label: "Search", href: "/opportunities", icon: "search" },
  { label: "Categories", href: "/categories", icon: "categories" },
  { label: "Countries", href: "/countries", icon: "globe" },
  { label: "Tracker", href: "/tracker", icon: "tracker" },
];

/**
 * Is this the page we are on?
 *
 * `/` has to match exactly or it is active on every page in the site. Everything else
 * matches its subtree, so `/opportunities/agritech-2026` lights the Search tab rather
 * than leaving the reader with no indication of where they are.
 */
export function isCurrent(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
