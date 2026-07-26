/**
 * Маршрутизация «событие → куда слать». ЕДИНСТВЕННОЕ место, которое трогает
 * новый проект — добавить строку в `ROUTES`, больше нигде ничего заводить не
 * нужно (ни новый секрет, ни новый .env, ни новый workflow-шаг).
 *
 * Id темы и id канала команды — НЕ секрет: без токена бота они бесполезны.
 * Поэтому они живут здесь, в коде, а не в переменных окружения — иначе
 * «добавить проект» снова означало бы правку в трёх местах вместо одного.
 * Секрет один — токен бота (`TELEGRAM_OPS_TOKEN`, см. `send.ts`).
 */
import type { NotifyEvent, Project } from './events.ts';
import { severity } from './events.ts';

/**
 * Форум-супергруппа «Ops». ЗАПОЛНИТЬ после Фазы 0 (владелец создаёт бота,
 * группу и темы руками — см. docs/rollout.md) — до этого момента строка
 * ниже намеренно невалидна, чтобы отправка падала явно, а не улетала в
 * никуда молча.
 */
export const OPS_CHAT = 'FILL_ME_AFTER_PHASE_0';

/** Тема «🔴 incidents» — сюда дублируется всё критическое со всех проектов. */
export const INCIDENTS_TOPIC = 0; // FILL_ME_AFTER_PHASE_0

/** Канал «Arvent Ops» — команда arvent, другие люди. Существует уже сейчас. */
export const ARVENT_TEAM_CHAT = '-1003972509373';

export const ROUTES: Record<
  Project,
  {
    /** Id темы форума для этого проекта. FILL_ME_AFTER_PHASE_0. */
    topic: number;
    /** Дополнительная цель для отдельных типов событий этого проекта. */
    extra?: { chat: string; types: NotifyEvent['type'][] };
  }
> = {
  playhub: { topic: 0 },
  'one-q': { topic: 0 },
  'game-publisher': { topic: 0 },
  arvent: { topic: 0, extra: { chat: ARVENT_TEAM_CHAT, types: ['pr', 'ci'] } }
};

export type Target = { chat: string; thread?: number; silent: boolean };

/**
 * Куда уходит конкретное событие. Три правила, без движка:
 *   1. всегда — тема проекта в форуме;
 *   2. если событие красное — дополнительно тема `incidents`;
 *   3. если тип события есть в `extra.types` проекта — дополнительно чат
 *      команды (сегодня это `pr`/`ci` у arvent — команда видит их в своём
 *      канале, а инфраструктура остаётся в форуме).
 */
export const targets = (e: NotifyEvent): Target[] => {
  const route = ROUTES[e.project];
  const isError = severity(e) === 'error';
  const out: Target[] = [{ chat: OPS_CHAT, thread: route.topic, silent: !isError }];

  if (isError) {
    out.push({ chat: OPS_CHAT, thread: INCIDENTS_TOPIC, silent: false });
  }

  if (route.extra?.types.includes(e.type)) {
    out.push({ chat: route.extra.chat, silent: !isError });
  }

  return out;
};
