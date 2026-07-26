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
 *   notify setup <project> "🎮 Название"   # создать тему в форуме, см. setup.ts
 */
import { readFileSync } from 'node:fs';
import type { NotifyEvent, Project } from './events.ts';
import { notify } from './send.ts';
import { setupTopic } from './setup.ts';

const log = (msg: string): void => console.error(`[notify] ${msg}`);

const args = process.argv.slice(2);
const command = args[0];

if (command === 'setup') {
  const [, project, title] = args;

  if (!project || !title) {
    log('использование: notify setup <project> "<название темы>"');
    process.exit(0);
  }

  await setupTopic(project, title);
  process.exit(0);
}

const flags = new Map<string, string[]>();

for (let i = 1; i < args.length; i++) {
  const arg = args[i];

  if (!arg.startsWith('--')) {
    continue;
  }

  const key = arg.slice(2);
  const takesValue = i + 1 < args.length && !args[i + 1].startsWith('--');
  const value = takesValue ? args[++i] : 'true';

  flags.set(key, [...(flags.get(key) ?? []), value]);
}

const one = (key: string): string | undefined => flags.get(key)?.[0];
const pairs = (key: string): Array<[string, string]> =>
  (flags.get(key) ?? []).map((s) => {
    const idx = s.indexOf('=');

    return idx === -1 ? [s, ''] : [s.slice(0, idx), s.slice(idx + 1)];
  });

const project = (): Project => one('project') as Project;

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
        status: one('status') as 'ok' | 'fail',
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
        status: one('status') as 'ok' | 'fail',
        stats: pairs('stat'),
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
        url: one('url')
      };
      break;
    case 'ci':
      event = {
        type: 'ci',
        project: project(),
        status: one('status') as 'ok' | 'fail',
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

if (event) {
  const result = await notify(event);

  log(result);
}

process.exit(0);
