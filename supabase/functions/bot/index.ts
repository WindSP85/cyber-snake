// NEON://SNAKE — Telegram-бот (Supabase Edge Function)
// Оживляет @windspsnake_bot: /start с кнопкой игры, /top — сезонный топ.
// Секрет BOT_TOKEN задаётся в Supabase → Edge Functions → Secrets.
const GAME_URL = "https://windsp85.github.io/cyber-snake/";
const SB_URL = "https://fjpwljcsumnabuymynpk.supabase.co";
const SB_KEY = "sb_publishable_ccfXAKoH5QhqVuTNxs6UUA_B83qU8WV"; // публичный по дизайну

const WELCOME =
  "⚡ NEON://SNAKE — киберпанк-змейка с боссами и онлайн-дуэлями!\n\n" +
  "▶ Жми кнопку внизу — и в бой.\n" +
  "🏆 /top — топ сезона\n" +
  "⚔ Онлайн-бой → «Позвать в бой» — позови друга из любого чата.";

serve(async function (req: Request) {
  try {
    const update: any = await req.json();
    const msg = update && update.message;
    if (!msg || !msg.text) return new Response("ok");

    const token = Deno.env.get("BOT_TOKEN") || "";
    if (!token) return new Response("no token", { status: 200 });
    const api = function (method: string, body: any) {
      return fetch("https://api.telegram.org/bot" + token + "/" + method, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    };
    const chatId = msg.chat.id;
    const keyboard = {
      keyboard: [[{ text: "▶ ИГРАТЬ", web_app: { url: GAME_URL } }]],
      resize_keyboard: true
    };
    const cmd = msg.text.trim().toLowerCase().split("@")[0];

    if (cmd === "/start" || cmd === "start") {
      await api("sendMessage", { chat_id: chatId, text: WELCOME, reply_markup: keyboard });
    } else if (cmd === "/top" || cmd === "/top5") {
      const r = await fetch(
        SB_URL + "/rest/v1/scores?select=name,score,level&order=score.desc&limit=5",
        { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } }
      );
      const rows: any = await r.json();
      const body = Array.isArray(rows) && rows.length
        ? rows.map(function (x: any, i: number) { return (i + 1) + ". " + x.name + " — " + x.score; }).join("\n")
        : "Пока пусто — стань первым чемпионом!";
      await api("sendMessage", {
        chat_id: chatId,
        text: "🏆 ТОП-5 СЕЗОНА:\n" + body,
        reply_markup: keyboard
      });
    } else {
      await api("sendMessage", {
        chat_id: chatId,
        text: "Я живой 🙂 Команды: /top — топ сезона. Игра — кнопка внизу.",
        reply_markup: keyboard
      });
    }
    return new Response("ok");
  } catch (e) {
    return new Response("ok"); // Telegram не любит ошибки — всегда 200
  }
});
