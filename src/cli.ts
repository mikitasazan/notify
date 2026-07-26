#!/usr/bin/env node
/**
 * `notify <type> [--flag value]...` — тонкий диспетчер. Ноль зависимостей:
 * разбор аргументов написан руками (не yargs/commander), потому что здесь
 * нужно ровно два вида флагов (одиночный и повторяемый `key=value`).
 *
 * Код возврата ВСЕГДА 0 — уведомление не имеет права уронить вызвавший его
 * деплой или задачу. Все ошибки — только в stderr. Исключения намеренно нет
 * (см. docs/rollout.md «чего не делаем»): сценария, где деплой должен упасть
 * из-за неотправленного сообщения, не существует.
 *
 *   notify deploy   --project playhub --status ok --commit "msg" --url "..."
 *   notify job      --project playhub --job "Импорт игр" --status ok --stat "добавлено=5"
 *   notify report   --project playhub --title "Сводка за день" --line "Игр=1284"
 *   notify ci       --project arvent  --status fail --branch master --actor saz_sam
 *   notify pr       --project arvent  --action opened --number 142 --title "..."
 *   notify incident --project arvent  --title "Redis недоступен" --detail "$ERR"
 *   notify <type> --json < payload.json   # весь объект события со stdin
 *   notify setup <chat_id форума> <ключ-проекта>   # создать вкладки, см. setup.ts
 */
import { readFileSync } from 'node:fs';
import type { NotifyEvent, Project } from './events.ts';
import { notify } from './send.ts';
import { setupTopic } from './setup.ts';

const log = (msg: string): void => console.error(`[notify] ${msg}`);

const args = process.argv.slice(2);
const command = args[0];

if (command === 'setup') {
  const [, chatId, projectKey] = args;

  if (!chatId || !projectKey) {
    log('использование: notify setup <chat_id форума> <ключ-проекта>');
    log('  сначала создай группу, включи в ней «Темы» и добавь бота админом');
    process.exit(0);
  }

  await setupTopic(chatId, projectKey);
  process.exit(0);
}

const flags = new Map<string, string[]>();
const parseErrors: string[] = [];

/** Флаги без значения. Всё остальное обязано его иметь. */
const BOOLEAN_FLAGS = new Set(['json']);

for (let i = 1; i < args.length; i++) {
  const arg = args[i];

  if (!arg.startsWith('--')) {
    parseErrors.push(`лишний аргумент без флага: «${arg}»`);
    continue;
  }

  // Форма `--key=value` обязательна для значений, начинающихся с `--`
  // (текст ошибки, кусок диффа): иначе они были бы съедены как флаги.
  const eq = arg.indexOf('=');

  if (eq !== -1) {
    const key = arg.slice(2, eq);
    flags.set(key, [...(flags.get(key) ?? []), arg.slice(eq + 1)]);
    continue;
  }

  const key = arg.slice(2);

  if (BOOLEAN_FLAGS.has(key)) {
    flags.set(key, ['true']);
    continue;
  }

  const next = args[i + 1];

  // Раньше флаг без значения молча становился строкой 'true'. Отсюда
  // `--url` в конце команды давал `href="true"`, Telegram отвечал 400 и
  // ТЕРЯЛОСЬ ВСЁ сообщение, а `--status` без значения рисовал 🔴 на
  // успешном деплое. Теперь это явная ошибка разбора.
  if (next === undefined || next.startsWith('--')) {
    parseErrors.push(`флаг --${key} без значения`);
    continue;
  }

  i++;
  flags.set(key, [...(flags.get(key) ?? []), next]);
}

const one = (key: string): string | undefined => flags.get(key)?.[0];

// --item "текст" или --item "текст|https://ссылка"
const items = (): Array<{ text: string; url?: string }> =>
  (flags.get('item') ?? []).map((raw) => {
    const idx = raw.lastIndexOf('|');

    return idx === -1 ? { text: raw } : { text: raw.slice(0, idx), url: raw.slice(idx + 1) };
  });
const pairs = (key: string): Array<[string, string]> =>
  (flags.get(key) ?? []).map((s) => {
    const idx = s.indexOf('=');

    return idx === -1 ? [s, ''] : [s.slice(0, idx), s.slice(idx + 1)];
  });

const project = (): Project => one('project') as Project;

/**
 * Всё, что не признано успехом, считается провалом.
 *
 * Тут важна не строгость, а согласованность: раньше `--status success`
 * (естественная опечатка при ручном вызове) рисовал 🔴 «упал», но `severity()`
 * видел «не fail» и слал сообщение БЕЗ звука. Красная плашка без звука —
 * худший исход: авария выглядит аварией, но не будит.
 */
const status = (): 'ok' | 'fail' => {
  const raw = (one('status') ?? '').toLowerCase();

  return raw === 'ok' || raw === 'success' || raw === 'passed' || raw === '0' ? 'ok' : 'fail';
};

let event: NotifyEvent | undefined;

if (flags.has('json')) {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf-8')) as Record<string, unknown>;

    event = { type: command, ...payload } as NotifyEvent;
  } catch (err) {
    log(`не удалось разобрать --json со stdin: ${err instanceof Error ? err.message : String(err)}`);
  }
} else {
  switch (command) {
    case 'deploy':
      event = {
        type: 'deploy',
        project: project(),
        status: status(),
        commit: one('commit'),
        url: one('url'),
        target: one('target')
      };
      break;
    case 'job':
      event = {
        type: 'job',
        project: project(),
        job: one('job') ?? '(без имени)',
        status: status(),
        stats: pairs('stat'),
        items: items(),
        note: one('note'),
        url: one('url')
      };
      break;
    case 'report':
      event = {
        type: 'report',
        project: project(),
        title: one('title') ?? '(без заголовка)',
        period: one('period'),
        lines: pairs('line'),
        items: items(),
        url: one('url')
      };
      break;
    case 'ci':
      event = {
        type: 'ci',
        project: project(),
        status: status(),
        branch: one('branch'),
        commit: one('commit'),
        actor: one('actor'),
        url: one('url')
      };
      break;
    case 'pr':
      event = {
        type: 'pr',
        project: project(),
        action: one('action') as 'opened' | 'review_requested' | 'merged',
        number: Number(one('number')),
        title: one('title') ?? '(без заголовка)',
        author: one('author'),
        reviewer: one('reviewer'),
        url: one('url')
      };
      break;
    case 'incident':
      event = {
        type: 'incident',
        project: project(),
        title: one('title') ?? '(без заголовка)',
        detail: one('detail'),
        url: one('url')
      };
      break;
    case 'heartbeat_miss':
      event = {
        type: 'heartbeat_miss',
        project: project(),
        job: one('job') ?? '(без имени)',
        lastSeen: one('last-seen'),
        expected: one('expected')
      };
      break;
    default:
      log(`неизвестный тип события: ${command ?? '(не указан)'}`);
  }
}

// Ошибки разбора — до отправки: лучше внятно сказать, что не так с командой,
// чем прислать сообщение с «true» вместо ссылки или 🔴 на успешном деплое.
if (parseErrors.length > 0) {
  for (const err of parseErrors) {
    log(err);
  }
  log('событие не отправлено — исправь команду');
  process.exit(0);
}

if (event) {
  // Ловим ВСЁ: уведомление не имеет права уронить деплой или крон, который
  // его вызвал. В bash с `set -e` (или в `trap ... ERR`) ненулевой код здесь
  // завалил бы саму задачу — ровно то, чего пакет обязан не делать.
  try {
    log(await notify(event));
  } catch (err) {
    log(`не отправлено: ${err instanceof Error ? err.message : String(err)}`);
  }
}

process.exit(0);
