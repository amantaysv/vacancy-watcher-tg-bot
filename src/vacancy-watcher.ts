import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { Telegraf } from "telegraf";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "state.json");
const POLL_INTERVAL_MS = 60_000; // как часто проверять группы

// Публичные группы/каналы, которые мониторит бот для всех пользователей
const DEFAULT_GROUPS: string[] = [
  "dev_connectablejobs",
  "Remoteit",
  "remocatedevs",
  "evacuatejobs",
  "Relocats",
  "zarubezhom_jobs",
  "forproducts",
  "young_relocate",
  "geekjobs",
  "youritjob",
  "easy_frontend_jobs",
  // "fordev",        // dead — no /s/ preview available
  "forpython",
  "DarikaINITVacancies",
  "revacancy",
  "forfrontend",
  // "cyprusithr",     // dead — no /s/ preview available
  "cyithr",
  "remotegeekjob",
  // "forgoanrust",    // dead — no /s/ preview available
  // "time2find",      // dead — no /s/ preview available
  "opento_dev",
  "findwork", // DevKG: вакансии (в основном офис, Бишкек)
  "remote", // DevKG: удалёнка / проекты / релокейт (он же @findremote — не добавлять второй раз)
];

// В постах DevKG только заголовок + ссылка на devkg.com, стек и требования
// лежат на сайте. Для этих каналов при промахе по тексту поста догружаем
// страницу вакансии и матчим ключевые слова по описанию.
const DEVKG_GROUPS = new Set(["findwork", "remote"]);
const DEVKG_LINK = /https?:\/\/devkg\.com\/tg\/j-\d+/;

interface UserState {
  keywords: string[];
  sentMessageIds: number[]; // message_id-ы, отправленные ботом в этот чат (для /clear)
}

interface AppState {
  users: Record<string, UserState>; // ключ — chatId (строка)
  lastSeen: Record<string, number>; // username -> id последнего показанного сообщения
}

function emptyUser(): UserState {
  return { keywords: [], sentMessageIds: [] };
}

function loadState(): AppState {
  if (!fs.existsSync(STATE_FILE)) return { users: {}, lastSeen: {} };
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch (e) {
    // Сохраняем битый файл, чтобы первый же saveState не затёр пользователей безвозвратно
    const broken = `${STATE_FILE}.broken-${Date.now()}`;
    fs.copyFileSync(STATE_FILE, broken);
    console.error(`Failed to parse state.json (копия: ${broken}), starting with empty state:`, e);
    return { users: {}, lastSeen: {} };
  }
  const users: Record<string, UserState> = parsed.users ?? {};
  // на случай апгрейда со старого state.json без sentMessageIds
  for (const key of Object.keys(users)) {
    if (!Array.isArray(users[key].sentMessageIds)) users[key].sentMessageIds = [];
  }
  return { users, lastSeen: parsed.lastSeen ?? {} };
}

function saveState(state: AppState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Truncating raw HTML at an arbitrary character count risks cutting a tag
// in half (e.g. "<a href=..." ), which makes Telegram reject the whole
// message with a parse error. If the formatted version is too long, fall
// back to plain escaped text (loses links/bold, but always sends).
function safeBody(html: string, plainText: string, maxLen: number): string {
  if (html.length <= maxLen) return html;
  return escapeHtml(plainText.slice(0, maxLen)) + "…";
}

function buildKeywordRegex(keywords: string[]): RegExp | null {
  if (keywords.length === 0) return null;
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}_])(${escaped.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
}

interface ScrapedMessage {
  id: number;
  text: string; // plain text, used for keyword matching
  html: string; // Telegram-safe HTML, used when sending (preserves links/bold)
  date: Date | null; // post timestamp, parsed from the widget's <time datetime="...">
}

// Converts the inner content of a .tgme_widget_message_text node into
// Telegram-safe HTML: keeps <b>/<strong>, <i>/<em>, <a href>, turns <br> into
// newlines, and escapes everything else so parse_mode: "HTML" never breaks.
function nodeToTelegramHtml($: cheerio.CheerioAPI, el: any): string {
  let out = "";
  $(el)
    .contents()
    .each((_, child) => {
      if (child.type === "text") {
        out += escapeHtml($(child).text());
        return;
      }
      if (child.type !== "tag") return;
      const tag = child.tagName?.toLowerCase();
      if (tag === "br") {
        out += "\n";
      } else if (tag === "a") {
        const href = $(child).attr("href") ?? "";
        out += `<a href="${escapeHtml(href)}">${escapeHtml($(child).text())}</a>`;
      } else if (tag === "b" || tag === "strong") {
        out += `<b>${escapeHtml($(child).text())}</b>`;
      } else if (tag === "i" || tag === "em") {
        out += `<i>${escapeHtml($(child).text())}</i>`;
      } else {
        out += escapeHtml($(child).text());
      }
    });
  return out.trim();
}

async function fetchGroupMessages(username: string): Promise<ScrapedMessage[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let html: string;
  try {
    const res = await fetch(`https://t.me/s/${username}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${username}`);
    html = await res.text();
  } finally {
    clearTimeout(timeout);
  }
  const $ = cheerio.load(html);

  const messages: ScrapedMessage[] = [];
  $(".tgme_widget_message_wrap").each((_, el) => {
    const wrap = $(el);
    const postAttr = wrap.find(".tgme_widget_message").attr("data-post");
    const id = postAttr ? parseInt(postAttr.split("/")[1] ?? "", 10) : NaN;
    const textNode = wrap.find(".tgme_widget_message_text");
    const text = textNode.text().trim();
    const html = nodeToTelegramHtml($, textNode.get(0));
    const datetimeAttr = wrap.find(".tgme_widget_message_date time").attr("datetime");
    const date = datetimeAttr ? new Date(datetimeAttr) : null;
    if (!Number.isNaN(id) && text) messages.push({ id, text, html, date });
  });

  return messages.sort((a, b) => a.id - b.id);
}

// Кэш описаний DevKG: url -> текст (null = не удалось загрузить).
// /test гоняет одни и те же посты повторно, поэтому кэш заметно экономит запросы.
const devkgCache = new Map<string, string | null>();
const DEVKG_CACHE_LIMIT = 500;

async function fetchDevkgDescription(url: string): Promise<string | null> {
  if (devkgCache.has(url)) return devkgCache.get(url)!;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let result: string | null = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());
    $("script, style, noscript, header, footer, nav").remove();
    let text = $("body").text().replace(/\s+/g, " ").trim();
    // Отрезаем сайдбар с чужими вакансиями, иначе "React" из соседней
    // вакансии даст ложное совпадение.
    for (const marker of ["Похожие вакансии", "Другие вакансии компании"]) {
      const idx = text.indexOf(marker);
      if (idx !== -1) text = text.slice(0, idx);
    }
    result = text || null;
  } catch (e) {
    console.error(`[devkg] Не удалось загрузить ${url}:`, e);
    result = null;
  } finally {
    clearTimeout(timeout);
  }

  if (devkgCache.size >= DEVKG_CACHE_LIMIT) {
    devkgCache.delete(devkgCache.keys().next().value!);
  }
  devkgCache.set(url, result);
  return result;
}

interface MatchResult {
  keyword: string;
  inDetails: boolean; // true — совпало только в описании на devkg.com
}

// Ленивая загрузка описания: один запрос на пост, даже если пользователей несколько.
function lazyDetails(username: string, msg: ScrapedMessage): () => Promise<string | null> {
  let promise: Promise<string | null> | undefined;
  return () => {
    if (!DEVKG_GROUPS.has(username)) return Promise.resolve(null);
    const url = msg.text.match(DEVKG_LINK)?.[0];
    if (!url) return Promise.resolve(null);
    promise ??= fetchDevkgDescription(url);
    return promise;
  };
}

async function findMatch(msg: ScrapedMessage, pattern: RegExp, getDetails: () => Promise<string | null>): Promise<MatchResult | null> {
  const direct = pattern.exec(msg.text);
  if (direct) return { keyword: direct[1], inDetails: false };
  const details = await getDetails();
  if (!details) return null;
  const deep = pattern.exec(details);
  return deep ? { keyword: deep[1], inDetails: true } : null;
}

function formatBody(username: string, msg: ScrapedMessage, match: MatchResult): string {
  const postLink = `https://t.me/${username}/${msg.id}`;
  const bodyText = msg.html.length <= 3800 ? msg.html : safeBody(msg.html, msg.text, 3800);
  const where = match.inDetails ? " <i>(в описании на devkg.com)</i>" : "";
  return `🔎 <b>${escapeHtml(match.keyword)}</b>${where}\n` + `📍 <a href="${postLink}">${username}</a>\n\n` + bodyText;
}

async function main() {
  const botToken = process.env.BOT_TOKEN ?? "";
  if (!botToken) {
    console.error("Задай BOT_TOKEN в .env (получи у @BotFather)");
    process.exit(1);
  }

  const state = loadState();
  const bot = new Telegraf(botToken);

  function ensureUser(chatId: number): UserState {
    const key = String(chatId);
    if (!state.users[key]) state.users[key] = emptyUser();
    return state.users[key];
  }

  function trackSent(chatId: number, messageId: number) {
    const user = ensureUser(chatId);
    user.sentMessageIds.push(messageId);
    // держим только последние 500 id на чат, чтобы state.json не разрастался
    if (user.sentMessageIds.length > 500) {
      user.sentMessageIds = user.sentMessageIds.slice(-500);
    }
    saveState(state);
  }

  bot.start((ctx) => {
    ensureUser(ctx.chat.id);
    saveState(state);
    ctx.reply(
      "Привет! Я слежу за вакансиями в группах по ключевым словам.\n\n" +
        "Добавь ключевые слова, например: /add react, frontend\n\n" +
        "Команды:\n" +
        "/keywords — список слов\n" +
        "/add слово1, слово2 — добавить слова\n" +
        "/remove слово — убрать слово\n" +
        "/status — статус\n" +
        "/test — проверить ключевые слова за последний день (/test 3 — за 3 дня)\n" +
        "/clear — удалить вакансии, которые бот прислал (только за последние 48ч, ограничение Telegram)",
    );
  });

  bot.command("add", (ctx) => {
    const user = ensureUser(ctx.chat.id);
    const raw = ctx.message.text.replace("/add", "").trim();
    if (!raw) return ctx.reply("Использование: /add react или /add react, svelte, typescript");

    const words = raw
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    const added: string[] = [];
    const skipped: string[] = [];

    for (const word of words) {
      if (user.keywords.includes(word)) skipped.push(word);
      else {
        user.keywords.push(word);
        added.push(word);
      }
    }
    saveState(state);

    const lines: string[] = [];
    if (added.length) lines.push(`Добавлено: ${added.join(", ")}`);
    if (skipped.length) lines.push(`Уже было: ${skipped.join(", ")}`);
    ctx.reply(lines.join("\n"));
  });

  bot.command("remove", (ctx) => {
    const user = ensureUser(ctx.chat.id);
    const raw = ctx.message.text.replace("/remove", "").trim();
    if (!raw) return ctx.reply("Использование: /remove react или /remove react, svelte");

    const words = raw
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    const removed: string[] = [];
    const notFound: string[] = [];

    for (const word of words) {
      if (user.keywords.includes(word)) {
        user.keywords = user.keywords.filter((k) => k !== word);
        removed.push(word);
      } else {
        notFound.push(word);
      }
    }
    saveState(state);

    const lines: string[] = [];
    if (removed.length) lines.push(`Удалено: ${removed.join(", ")}`);
    if (notFound.length) lines.push(`Не найдено: ${notFound.join(", ")}`);
    ctx.reply(lines.join("\n"));
  });

  bot.command("keywords", (ctx) => {
    const user = ensureUser(ctx.chat.id);
    ctx.reply(user.keywords.length ? user.keywords.join(", ") : "Список пуст");
  });

  bot.command("status", (ctx) => {
    const user = ensureUser(ctx.chat.id);
    ctx.reply(`Ключевых слов: ${user.keywords.length}\n` + `Отслеживаемых групп: ${DEFAULT_GROUPS.length}`);
  });

  // Диагностическая/ежедневная команда: гоняет текущие ключевые слова по
  // постам за последние N дней (по умолчанию 1) во всех группах, игнорируя
  // lastSeen. Использование: /test или /test 3 (за последние 3 дня).
  bot.command("test", async (ctx) => {
    const user = ensureUser(ctx.chat.id);
    const pattern = buildKeywordRegex(user.keywords);
    if (!pattern) return ctx.reply("Нет ключевых слов. Добавь через /add");

    const raw = ctx.message.text.replace("/test", "").trim();
    const days = raw && !Number.isNaN(Number(raw)) && Number(raw) > 0 ? Number(raw) : 1;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    await ctx.reply(`Проверяю ${DEFAULT_GROUPS.length} групп по ${user.keywords.length} словам за последние ${days} дн...`);

    let found = 0;
    for (const username of DEFAULT_GROUPS) {
      try {
        const messages = await fetchGroupMessages(username);
        const recent = messages.filter((m) => m.date !== null && m.date.getTime() >= cutoff);
        console.log(`[test] [${username}] fetched=${messages.length} recent${days}d=${recent.length}`);
        for (const msg of recent) {
          const match = await findMatch(msg, pattern, lazyDetails(username, msg));
          if (match) {
            found++;
            const sent = await ctx.reply(formatBody(username, msg, match), { parse_mode: "HTML" });
            trackSent(ctx.chat.id, sent.message_id);
          }
        }
      } catch (e) {
        console.error(`[test] Ошибка ${username}:`, e);
        await ctx.reply(`Ошибка при получении ${username}: ${e}`);
      }
    }
    if (!found) ctx.reply(`За последние ${days} дн совпадений не найдено ни в одной группе.`);
    else ctx.reply(`Готово. Найдено совпадений за ${days} дн: ${found}`);
  });

  // Удаляет сообщения с вакансиями, которые бот прислал в этот чат.
  // Telegram Bot API позволяет боту удалять свои сообщения только в
  // течение 48 часов после отправки — более старые не удалятся, это
  // ограничение самого API, не бота.
  bot.command("clear", async (ctx) => {
    const user = ensureUser(ctx.chat.id);
    const ids = user.sentMessageIds;
    if (ids.length === 0) {
      return ctx.reply("Нечего удалять — бот ещё не присылал вакансий в этот чат.");
    }

    let deleted = 0;
    let failed = 0;
    for (const messageId of ids) {
      try {
        await bot.telegram.deleteMessage(ctx.chat.id, messageId);
        deleted++;
      } catch (e) {
        failed++;
      }
    }

    user.sentMessageIds = [];
    saveState(state);

    const status = await ctx.reply(`Удалено: ${deleted}` + (failed > 0 ? `\nНе удалось удалить (старше 48ч или уже удалены): ${failed}` : ""));
    trackSent(ctx.chat.id, status.message_id);
  });

  bot.launch();
  console.log("Бот запущен.");

  // ---------- Фоновая проверка групп ----------
  async function pollOnce() {
    for (const username of DEFAULT_GROUPS) {
      let messages: ScrapedMessage[];
      try {
        messages = await fetchGroupMessages(username);
      } catch (e) {
        console.error(`Не удалось получить ${username}:`, e);
        continue;
      }
      console.log(`[poll] [${username}] fetched=${messages.length}`);

      if (messages.length === 0) continue;

      const lastId = state.lastSeen[username];
      if (lastId === undefined) {
        // первый раз видим эту группу — просто запоминаем последний id, без рассылки
        state.lastSeen[username] = messages[messages.length - 1].id;
        saveState(state);
        console.log(`[poll] [${username}] baseline установлен на ${state.lastSeen[username]}, ничего не отправлено (первый запуск)`);
        continue;
      }

      const newMessages = messages.filter((m) => m.id > lastId);
      console.log(`[poll] [${username}] new=${newMessages.length}`);
      if (newMessages.length === 0) continue;

      state.lastSeen[username] = messages[messages.length - 1].id;
      saveState(state);

      for (const msg of newMessages) {
        const getDetails = lazyDetails(username, msg);
        for (const [chatIdStr, user] of Object.entries(state.users)) {
          const pattern = buildKeywordRegex(user.keywords);
          if (!pattern) continue;
          const match = await findMatch(msg, pattern, getDetails);
          if (!match) continue;

          const body = formatBody(username, msg, match);

          try {
            const sent = await bot.telegram.sendMessage(Number(chatIdStr), body, {
              parse_mode: "HTML",
            });
            trackSent(Number(chatIdStr), sent.message_id);
          } catch (e) {
            console.error(`Не удалось отправить ${chatIdStr}:`, e);
          }
        }
      }
    }
  }

  let polling = false;
  await pollOnce();
  setInterval(() => {
    if (polling) return;
    polling = true;
    pollOnce()
      .catch((e) => console.error("Ошибка при опросе групп:", e))
      .finally(() => {
        polling = false;
      });
  }, POLL_INTERVAL_MS);

  console.log(`Опрашиваю группы каждые ${POLL_INTERVAL_MS / 1000} сек.`);
}

main().catch(console.error);

process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
