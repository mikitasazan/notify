/**
 * `notify setup <project> "<название>"` — создаёт тему в форуме через Bot API
 * `createForumTopic` и печатает готовую строку для `routes.ts`.
 *
 * Для пяти исходных проектов НЕ используется — их темы владелец создал руками
 * в Фазе 0 (см. docs/rollout.md), а их id считаны один раз через
 * `reading-telegram` и вписаны в `routes.ts` напрямую. Эта команда — для
 * проектов, которые появятся ПОСЛЕ: у бота уже есть право «Управление
 * темами», значит подключение нового проекта не требует снова открывать
 * Telegram руками.
 */
import { OPS_CHAT } from './routes.ts';

const log = (msg: string): void => console.error(`[notify] ${msg}`);

export const setupTopic = async (project: string, title: string): Promise<void> => {
  const token = process.env.TELEGRAM_OPS_TOKEN?.trim();

  if (!token) {
    log('нет TELEGRAM_OPS_TOKEN — не могу создать тему');

    return;
  }

  if (OPS_CHAT === 'FILL_ME_AFTER_PHASE_0') {
    log('OPS_CHAT в src/routes.ts ещё не заполнен — сначала пройти Фазу 0');

    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: OPS_CHAT, name: title }),
    signal: AbortSignal.timeout(10_000)
  });

  const body = (await res.json()) as {
    ok: boolean;
    result?: { message_thread_id: number };
    description?: string;
  };

  if (!body.ok || !body.result) {
    log(`не удалось создать тему: ${body.description ?? `HTTP ${res.status}`}`);
    log('проверь: бот админ группы с правом «Управление темами»?');

    return;
  }

  const topic = body.result.message_thread_id;

  log(`тема "${title}" создана, id=${topic}`);
  log('добавь в src/routes.ts:');
  log(`  ${JSON.stringify(project)}: { topic: ${topic} },`);
};
