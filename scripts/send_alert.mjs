#!/usr/bin/env node
/**
 * vetflu send_alert.mjs — v2.2: Telegram-уведомления о смене уровня риска.
 * Запускается в update.yml ПОСЛЕ build_model.mjs (в model.json есть out.alert).
 *
 * Уровни (пороги из model.alert.thresholds): ok < 45 ≤ watch < 75 ≤ alert; static — live-множителей нет.
 * Пуш отправляется ТОЛЬКО при смене уровня относительно data/alert_state.json (дедуп) —
 * переход watch→alert тоже уведомляет (эскалация), alert→ok — «отбой».
 *
 * Секреты GitHub: TELEGRAM_BOT_TOKEN (BotFather), TELEGRAM_CHAT_ID (канал/чат, минус для групп).
 * Если секреты не заданы — state всё равно обновляется (чтобы после добавления секретов
 * уведомления шли только за новые переходы), в лог пишется ::notice:: с инструкцией.
 * Скрипт всегда завершается с кодом 0 — алерты не должны ломать ежедневную сборку.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODEL = join(ROOT, "data", "model.json");
const STATE = join(ROOT, "data", "alert_state.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || "";

const LEVEL_ICON = { ok: "🟢", watch: "🟠", alert: "🔴", static: "⚪️" };
const LEVEL_TEXT = {
  ok: "фон (R < 45)",
  watch: "активный пролёт / риск (R ≥ 45)",
  alert: "ОКНО ВЫСОКОГО РИСКА (R ≥ 75)",
};

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

async function main() {
  try {
    const model = loadJson(MODEL, null);
    if (!model || !model.alert || !Array.isArray(model.flyways)) {
      console.warn("[alert] model.json без alert-блока — пропуск");
      return;
    }
    const level = model.alert.level;
    const state = loadJson(STATE, { level: null, notified_at: null });
    const changed = state.level !== level;

    // state обновляем всегда: дедуп должен переживать и «секретов ещё нет», и ручные прогоны
    if (changed) {
      writeFileSync(STATE, JSON.stringify({ level, notified_at: changed ? new Date().toISOString() : state.notified_at, max_r: model.alert.max_r }));
      console.log(`[alert] state: ${state.level ?? "—"} → ${level} (записано)`);
    } else {
      console.log(`[alert] state: ${level} (без изменений — уведомление не требуется)`);
      return;
    }

    if (level === "static") {
      console.log("[alert] live-множителей нет (static) — уведомление не отправляется");
      return;
    }

    if (!TOKEN || !CHAT) {
      console.log("::notice::Telegram-секреты не настроены (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — уровень изменился на «" + level + "», но уведомление не отправлено. Добавьте два секрета в Settings → Secrets → Actions: токен от @BotFather и ID чата/канала.");
      return;
    }

    // тело: флайвеи с живым R, в порядке убывания
    const rows = model.flyways
      .map((f) => {
        const s = model.series[f.id].weeks.find((w) => w.r != null);
        return s ? { f, s } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.s.r - a.s.r);
    if (!rows.length) { console.log("[alert] нет живых R — пропуск тела"); return; }

    const lines = rows.map(({ f, s }) =>
      `• <b>${escHtml(f.short)}</b> — R <b>${s.r}</b> (${escHtml(LEVEL_TEXT[s.r >= 75 ? "alert" : s.r >= 45 ? "watch" : "ok"] || "")}) · ${escHtml(s.ph_r || s.ph)} · канал: ${escHtml((model.channels && model.channels[s.chan] && model.channels[s.chan].label) || s.chan)} · MW ${s.mw ?? 1} × MB ${s.mb ?? 1} × BP ${s.bp ?? 1} × WD ${s.wd ?? 1}`);
    const text =
      `${LEVEL_ICON[level] || "•"} <b>VetFlu: уровень «${level}»</b> — ${escHtml(LEVEL_TEXT[level] || "")}\n` +
      lines.join("\n") +
      `\n\n<i>Порог: ${model.alert.max_r ?? "—"} (max R). Детали: shray77.github.io/vetflu-site</i>`;

    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.warn(`[alert] Telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } else {
      console.log(`[alert] Telegram OK → ${CHAT}`);
    }
  } catch (err) {
    console.warn(`[alert] FAILED: ${err.message}`);
  } finally {
    process.exitCode = 0;
  }
}

main();
