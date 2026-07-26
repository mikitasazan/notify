/**
 * Транспорт. Переносит проверенный на проде код из
 * game-publisher/scripts/lib/telegram.ts (fetch → curl-фолбэк через stdin,
 * `.trim()` токена) и добавляет то, чего там не было: несколько целей за
 * вызов, `message_thread_id`, повтор на HTTP 429 с уважением `retry_after`,
 * повтор на 5xx, отказ без повтора на прочих 4xx.
 *
 * Токен — ТОЛЬКО из `process.env.OPS_BOT_TOKEN`, с `.trim()`: перевод
 * строки в токене (частая находка при копипасте) заставляет curl разобрать
 * конфиг как две директивы и утащить хвост токена в stderr прогона.
 *
 * Нет токена → 'skipped', не исключение: уведомление не имеет права уронить
 * деплой или регулярную задачу, которая его вызвала.
 */
import { execFileSync } from 'node:child_process';
import type { NotifyEvent, Project } from './events.ts';
import { clampMessage, render } from './render.ts';
import type { Target } from './routes.ts';
import { ROUTES, targets } from './routes.ts';

export type SendResult = 'sent' | 'skipped' | 'failed';

const log = (msg: string): void => {
  // stderr, не stdout — stdout зарезервирован под возможный машинный вывод CLI.
  console.error(`[notify] ${msg}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const buildBody = (target: Target, text: string): string =>
  JSON.stringify({
    chat_id: target.chat,
    ...(target.thread ? { message_thread_id: target.thread } : {}),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: target.silent
  });

/**
 * Запасной путь: curl — другой стек TLS/DNS, выручает там, где fetch/undici
 * не маршрутизирует. URL с токеном уходит файлом конфига через stdin, а не
 * аргументом: в argv его видно любому пользователю сервера через `ps aux`.
 * stderr — в 'pipe', а не наследуется: сообщение об ошибке curl может
 * содержать кусок URL с токеном, в лог прогона он попадать не должен.
 */
const sendViaCurl = (token: string, target: Target, text: string): 'ok' | 'fail' | 'retry' => {
  const config = [
    `url = "https://api.telegram.org/bot${token}/sendMessage"`,
    'request = "POST"',
    'header = "Content-Type: application/json"',
    `data = ${JSON.stringify(buildBody(target, text))}`,
    'max-time = 15',
    'silent',
    'fail'
  ].join('\n');

  try {
    execFileSync('curl', ['--config', '-'], {
      input: config,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return 'ok';
  } catch (err) {
    // 28 — собственный таймаут curl (`max-time` выше). Как и таймаут fetch, он
    // означает «ответа нет», а не «не доставлено»: повтор положил бы в чат
    // вторую копию. Всё остальное (отказ соединения, 4xx с `fail`) повторить
    // безопасно.
    return (err as { status?: number }).status === 28 ? 'fail' : 'retry';
  }
};

type Attempt = { outcome: 'ok' } | { outcome: 'fail' } | { outcome: 'retry'; waitMs: number };

const attempt = async (token: string, target: Target, text: string): Promise<Attempt> => {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildBody(target, text),
      signal: AbortSignal.timeout(10_000)
    });

    if (res.ok) {
      return { outcome: 'ok' };
    }

    if (res.status === 429) {
      const body = (await res.json().catch(() => null)) as { parameters?: { retry_after?: number } } | null;
      const retryAfter = typeof body?.parameters?.retry_after === 'number' ? body.parameters.retry_after : 5;

      return { outcome: 'retry', waitMs: Math.min(retryAfter, 60) * 1000 };
    }

    if (res.status >= 500) {
      return { outcome: 'retry', waitMs: 1000 };
    }

    // 4xx кроме 429 — постоянная ошибка (не тот thread, бот не админ,
    // неверный chat_id). Повтор её не исправит.
    //
    // Причину обязательно вытаскиваем: Telegram кладёт её в `description`
    // («message thread not found», «can't parse entities»), и без неё понять,
    // почему уведомления пропали, невозможно — а разбираться будет не
    // разработчик, а владелец.
    const detail = (await res.json().catch(() => null)) as { description?: string } | null;

    log(`HTTP ${res.status}: ${detail?.description ?? 'без описания'} — не повторяем, ошибка постоянная`);

    return { outcome: 'fail' };
  } catch (err) {
    // Таймаут — НЕ то же самое, что «не доставлено»: запрос мог дойти, а ответ
    // не успеть вернуться. Повтор (хоть curl-ом, хоть следующей попыткой) кладёт
    // в чат второй экземпляр того же сообщения — дедупа у Bot API нет. Поэтому
    // на таймауте останавливаемся и честно пишем 'failed': лишняя копия аварии
    // хуже, чем пропущенная строка в логе, а сообщение, скорее всего, ушло.
    if (err instanceof Error && err.name === 'TimeoutError') {
      log('таймаут ответа — не повторяем: сообщение могло уже уйти');

      return { outcome: 'fail' };
    }

    // Сюда попадают отказы соединения (DNS, TLS, сеть недоступна) — запрос не
    // ушёл, дубля быть не может, фолбэк безопасен.
    log('fetch не прошёл, пробуем curl…');

    const curl = sendViaCurl(token, target, text);

    return curl === 'retry' ? { outcome: 'retry', waitMs: 1000 } : { outcome: curl };
  }
};

const MAX_ATTEMPTS = 3;

const sendOne = async (token: string, target: Target, text: string): Promise<'sent' | 'failed'> => {
  let waitMs = 0;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const result = await attempt(token, target, text);

    if (result.outcome === 'ok') {
      return 'sent';
    }

    if (result.outcome === 'fail') {
      return 'failed';
    }

    waitMs = result.waitMs;
  }

  log('исчерпаны попытки отправки');

  return 'failed';
};

/** Общий хвост для `notify` и `sendReport`: токен, цели, последовательная отправка. */
const deliver = async (where: Target[], text: string): Promise<SendResult> => {
  const token = process.env.OPS_BOT_TOKEN?.trim();

  if (!token) {
    log('нет OPS_BOT_TOKEN — сообщение не отправлено');

    return 'skipped';
  }

  if (where.length === 0) {
    return 'skipped';
  }

  const results: Array<'sent' | 'failed'> = [];

  // Последовательно, не Promise.all: провал одной цели не должен гонять
  // ретраи параллельно с остальными и колотить API по нескольким чатам разом.
  for (const target of where) {
    results.push(await sendOne(token, target, text));
  }

  return results.includes('sent') ? 'sent' : 'failed';
};

/**
 * Отправляет событие во все его цели (тема проекта + при необходимости
 * `incidents` + чат команды). Цели идут последовательно; провал одной не
 * отменяет остальные. `'sent'`, если хотя бы одна цель получила сообщение.
 */
export const notify = async (e: NotifyEvent): Promise<SendResult> => deliver(targets(e), render(e));

/**
 * Готовый HTML во вкладку «Ops» проекта — ТОЛЬКО для дневных отчётов.
 *
 * Зачем исключение из правила «свободного текста в API нет». Отчёт — это не
 * событие: в нём плотная строка вроде
 * `🎮 1284 игр (🍎 412 iOS +3 · 🤖 890 Android +5) | 📈 +240 запусков`,
 * и разложить её в `label=value` можно только испортив. Но транспорт у отчёта
 * ТОТ ЖЕ: ретраи, 429, таймауты, curl-фолбэк, номер вкладки. Пока его копировали
 * в каждый скрипт, один и тот же баг с дублями на таймауте пришлось чинить
 * дважды — в пакете и в game-publisher (27.07.2026).
 *
 * Граница: формат событий по-прежнему задаёт только пакет, «своё» уведомление
 * о деплое или упавшей задаче написать нельзя. Здесь стандартизирован транспорт,
 * а не формат — и в этом весь смысл.
 *
 * Всегда беззвучно: отчёт читают утром, а не по звонку.
 */
export const sendReport = async (project: Project, html: string): Promise<SendResult> => {
  const forum = ROUTES[project];

  if (!forum) {
    log(`неизвестный проект «${project}» — отчёт не отправлен`);

    return 'skipped';
  }

  return deliver([{ chat: forum.chat, thread: forum.ops, silent: true }], clampMessage(html));
};
