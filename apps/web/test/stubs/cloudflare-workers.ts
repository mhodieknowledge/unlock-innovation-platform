/**
 * `cloudflare:workers` outside the Workers runtime.
 *
 * The module is built into workerd, so Node cannot resolve it and vitest needs something to
 * point at. This stub is not a pretend Worker: it is the truthful answer that there are no
 * bindings here. Every consumer of lib/runtime.ts is written for the unconfigured case — that
 * is what makes the empty state and the degraded search real rather than theoretical — so a
 * test gets the same behaviour a deploy with nothing configured gets, and a test that needs a
 * value passes it in explicitly.
 */
export const env: Record<string, unknown> = {};
