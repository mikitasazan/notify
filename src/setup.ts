/**
 * `notify setup "<Название проекта>"` — заводит вкладки «⚙️ Ops» и «💬 Dev»
 * в уже созданном форуме и печатает готовую строку для `ROUTES`.
 *
 * Сам форум-супергруппу бот создать не может — Telegram разрешает это только
 * живому аккаунту. Поэтому порядок для нового проекта такой:
 *   1. создать группу в Telegram, включить в ней «Темы», добавить
 *      @mikita_ops_bot администратором с правом «Управление темами»;
 *   2. `notify setup <chat_id>` — заведёт обе вкладки и напечатает строку;
 *   3. вставить строку в `src/routes.ts`.
 *
 * Шаг 1 делается один раз на проект и занимает полминуты; шаги 2–3 —
 * механические.
 */
const log = (msg: string): void => console.error(`[notify] ${msg}`);

const createTopic = async (token: string, chat: string, name: string, color: number): Promise<number | null> => {
  const res = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, name, icon_color: color }),
    signal: AbortSignal.timeout(10_000)
  });

  const body = (await res.json()) as {
    ok: boolean;
    result?: { message_thread_id: number };
    description?: string;
  };

  if (!body.ok || !body.result) {
    log(`не удалось создать «${name}»: ${body.description ?? `HTTP ${res.status}`}`);

    return null;
  }

  return body.result.message_thread_id;
};

export const setupTopic = async (chatId: string, projectKey: string): Promise<void> => {
  const token = (process.env.OPS_BOT_TOKEN ?? process.env.TELEGRAM_OPS_TOKEN)?.trim();

  if (!token) {
    log('нет OPS_BOT_TOKEN — не могу создать вкладки');

    return;
  }

  const ops = await createTopic(token, chatId, '⚙️ Ops', 9367192);
  const dev = await createTopic(token, chatId, '💬 Dev', 7322096);

  if (ops === null || dev === null) {
    log('проверь: бот админ группы с правом «Управление темами», а темы в группе включены?');

    return;
  }

  log(`вкладки созданы: Ops=${ops}, Dev=${dev}`);
  log('добавь в src/routes.ts:');
  log(`  ${JSON.stringify(projectKey)}: { chat: '${chatId}', ops: ${ops}, dev: ${dev} },`);
};
