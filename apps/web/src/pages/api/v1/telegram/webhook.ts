import type { APIRoute } from "astro";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { BRAND, NO_FEE_STATEMENT } from "@mbele/config";
import { countdownLabel, deadlineFacts } from "~/lib/deadline";
import { reportError } from "~/lib/errors";

/**
 * Telegram bot. API_SPEC.md §13, UX_FLOWS.md §15.
 *
 * "A first-class read client, not a notification pipe." That framing is the whole
 * point: 00_PASS1_ECOSYSTEM_RESEARCH.md §1.1 found discovery is overwhelmingly
 * push-based through messaging apps, not search, so a web-only product "starts at
 * a structural disadvantage". The bot is where the audience already is.
 *
 * Plain text, at most three inline buttons, no images, no media
 * (API_SPEC.md §13) — a message that costs nothing to receive on a metered
 * connection.
 *
 * ON KEYS. This route runs at the edge, so it holds NO database-wide key:
 * SECURITY.md §2 says the service key is "never present in a Worker environment
 * reachable from the edge". Everything the bot needs that crosses users — redeem a
 * code, read the tracker behind a linked chat, evaluate that chat's eligibility —
 * goes through a SECURITY DEFINER function in migration 0009 that verifies
 * TELEGRAM_BOT_SECRET inside the database. A leak of that secret reaches those five
 * functions and nothing else, and the eligibility profile never leaves the
 * database: only the verdict comes back (invariant 6).
 */
export const prerender = false;

interface TelegramUpdate {
  message?: {
    chat?: { id?: number };
    text?: string;
    from?: { id?: number };
  };
}

const HELP = `What I can do:

/today — up to 5 things closing this week you can enter
/closing — the next 10 by deadline
/country ZW — everything open to a country
/search <words> — top 5 matches
/link <code> — connect your account
/me — your tracker summary
/pause — stop pushes for 30 days
/stop — unlink completely

${NO_FEE_STATEMENT}`;

/**
 * Escapes text for Telegram's MarkdownV2. Every reserved character must be
 * escaped or the API rejects the whole message — and opportunity titles routinely
 * contain parentheses, hyphens and full stops.
 */
const esc = (s: string): string => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);

async function send(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      // No link previews: they cost the recipient bytes on a metered connection
      // for a thumbnail they did not ask for.
      link_preview_options: { is_disabled: true },
    }),
  });
}

function formatOpportunity(
  o: {
    slug: string;
    title: string;
    deadline_at: string | null;
    deadline_precision: string;
    deadline_raw: string | null;
    is_rolling: boolean;
    opens_at: string | null;
    cost: string;
    organisations?: { name?: string } | null;
  },
  domain: string,
  verdict?: string,
): string {
  const facts = deadlineFacts({
    deadline_at: o.deadline_at,
    deadline_precision: o.deadline_precision as never,
    opens_at: o.opens_at,
    is_rolling: o.is_rolling,
  });

  const lines = [
    `*${esc(o.title)}*`,
    esc(
      [
        countdownLabel(facts),
        o.organisations?.name ?? null,
        o.cost === "free" ? "Free to enter" : null,
        verdict ? verdictWord(verdict) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    esc(`https://${domain}/opportunities/${o.slug}`),
  ];
  return lines.join("\n");
}

/** Plain words, never a bare enum value. The bot has no colour to lean on. */
function verdictWord(verdict: string): string {
  switch (verdict) {
    case "eligible":
      return "You're eligible";
    case "likely_eligible":
      return "Likely eligible";
    case "not_eligible":
      return "Not eligible";
    default:
      return "Eligibility unclear";
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals as { runtime?: { env?: Record<string, string> } }).runtime?.env ?? {};
  const token = env["TELEGRAM_BOT_TOKEN"];
  const webhookSecret = env["TELEGRAM_WEBHOOK_SECRET"];
  const supabaseUrl = env["SUPABASE_URL"];
  const anonKey = env["SUPABASE_ANON_KEY"];
  const botSecret = env["TELEGRAM_BOT_SECRET"];

  // API_SPEC.md §13: secret-token verified. Telegram sends this header on every
  // update; without it, anyone who learns the URL can impersonate Telegram.
  if (webhookSecret && request.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret) {
    return new Response("forbidden", { status: 403 });
  }

  // Always 200 to Telegram, whatever happens. A non-2xx makes Telegram retry the
  // same update indefinitely, which turns one bug into a flood.
  const ok = () => new Response("ok", { status: 200 });

  if (!token) return ok();

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return ok();
  }

  const chatId = update.message?.chat?.id;
  const text = (update.message?.text ?? "").trim();
  if (!chatId || !text.startsWith("/")) return ok();

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand!.split("@")[0]!.toLowerCase();
  const argument = rest.join(" ").slice(0, 200);

  // ONE client, the public anon key. Personal commands are reachable only because
  // the bot secret unlocks the definer functions; without the secret the bot
  // degrades to public catalogue reads, which is the correct failure mode.
  const db: SupabaseClient | null =
    supabaseUrl && anonKey
      ? createClient(supabaseUrl, anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  const personal = db && botSecret ? db : null;
  const chat = String(chatId);
  const domain = BRAND.domain;

  try {
    switch (command) {
      case "/start":
      case "/help": {
        await send(
          token,
          chatId,
          `${esc(`${BRAND.name} — open opportunities across Africa, with a straight answer on whether you can apply.`)}\n\n${esc(HELP)}`,
        );
        return ok();
      }

      case "/link": {
        if (!personal || !argument) {
          await send(token, chatId, esc("Send /link followed by the code from your settings page."));
          return ok();
        }
        const { data: linked } = await personal.rpc("bot_redeem_link", {
          p_secret: botSecret,
          p_code: argument.trim(),
          p_chat_id: chat,
        });
        await send(
          token,
          chatId,
          linked === true
            ? esc("Linked. You'll get deadline reminders here instead of by email.")
            : // Deliberately one message for expired, used and unknown: a distinct
              // reply for each would tell a stranger which codes exist.
              esc("That code didn't work. Codes last 15 minutes — generate a fresh one."),
        );
        return ok();
      }

      case "/pause": {
        if (personal) {
          await personal.rpc("bot_pause", { p_secret: botSecret, p_chat_id: chat });
        }
        await send(token, chatId, esc("Paused for 30 days. Your account and saved items are untouched."));
        return ok();
      }

      case "/stop": {
        // NOTIFICATIONS.md §7: honoured immediately, and without asking why.
        if (personal) {
          await personal.rpc("bot_unlink", { p_secret: botSecret, p_chat_id: chat });
        }
        await send(token, chatId, esc("Unlinked. You won't hear from me again unless you link a new code."));
        return ok();
      }

      case "/today":
      case "/closing":
      case "/country":
      case "/search": {
        if (!db) {
          await send(token, chatId, esc("I can't reach the catalogue right now. Try again shortly."));
          return ok();
        }

        let query = db
          .from("opportunities")
          .select(
            "slug, title, deadline_at, deadline_precision, deadline_raw, is_rolling, opens_at, cost, id, organisations(name)",
          )
          .eq("status", "published")
          .order("deadline_at", { ascending: true, nullsFirst: false });

        if (command === "/country") {
          const iso2 = argument.toUpperCase().slice(0, 2);
          if (!/^[A-Z]{2}$/.test(iso2)) {
            await send(token, chatId, esc("Send /country followed by a two-letter code, like /country ZW."));
            return ok();
          }
          query = query.or(
            `eligible_countries.cs.{${iso2}},eligibility_scope.in.(africa_wide,global)`,
          );
        } else if (command === "/search") {
          if (!argument) {
            await send(token, chatId, esc("Send /search followed by what you're looking for."));
            return ok();
          }
          query = query.textSearch("search_vector", argument, { type: "websearch" });
        } else if (command === "/today") {
          query = query.lte(
            "deadline_at",
            new Date(Date.now() + 7 * 86_400_000).toISOString(),
          );
        }

        const limit = command === "/closing" ? 10 : 5;
        const { data } = await query.limit(limit);
        const rows = (data ?? []) as unknown as { id: string }[];

        if (rows.length === 0) {
          await send(
            token,
            chatId,
            esc(
              command === "/today"
                ? "Nothing closes in the next 7 days that we've published. That's the honest answer, not an error."
                : "Nothing matched. Try /closing for what's next by deadline.",
            ),
          );
          return ok();
        }

        // Personalise if this chat is linked. bot_verdicts runs the engine's SQL
        // mirror against the stored profile and returns verdicts only — the
        // profile itself never crosses the wire (invariant 6), and parity with the
        // TypeScript engine is held down by scripts/engine-parity.mjs so a user
        // cannot see one verdict here and another on the web.
        const verdicts = new Map<string, string>();
        if (personal) {
          const { data: verdictRows } = await personal.rpc("bot_verdicts", {
            p_secret: botSecret,
            p_chat_id: chat,
            p_opportunity_ids: rows.map((r) => r.id),
          });
          for (const row of (verdictRows ?? []) as {
            opportunity_id: string;
            verdict: string;
          }[]) {
            verdicts.set(row.opportunity_id, row.verdict);
          }
        }

        const body = rows
          .map((o) => formatOpportunity(o as never, domain, verdicts.get(o.id)))
          .join("\n\n");

        await send(token, chatId, body + "\n\n" + esc("/pause to stop these · /help"));
        return ok();
      }

      case "/me": {
        if (!personal) {
          await send(token, chatId, esc("I can't reach your tracker right now."));
          return ok();
        }

        const { data: summary } = await personal.rpc("bot_tracker_summary", {
          p_secret: botSecret,
          p_chat_id: chat,
        });

        const counts = (summary ?? []) as { state: string; n: number }[];

        // An unlinked chat and a linked chat with an empty tracker both come back
        // empty here, so the reply has to cover both without claiming either.
        if (counts.length === 0) {
          await send(
            token,
            chatId,
            esc(
              "Nothing tracked yet — or this chat isn't linked. Send /link with a code from your settings.",
            ) +
              "\n\n" +
              esc(`https://${domain}/tracker`),
          );
          return ok();
        }

        const body = counts
          .map(({ state, n }) => `${state.replace(/_/g, " ")}: ${n}`)
          .join("\n");

        await send(token, chatId, esc(body) + "\n\n" + esc(`https://${domain}/tracker`));
        return ok();
      }

      default: {
        await send(token, chatId, esc(HELP));
        return ok();
      }
    }
  } catch (err) {
    await reportError(err, { route: "/api/v1/telegram/webhook", tags: { command } }, env);
    // Still 200: see the note above about retry floods.
    return ok();
  }
};
