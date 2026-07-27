/**
 * Один рендерер на тип события, все по одному каркасу:
 *
 *   эмодзи Заголовок · проект
 *   ключ: значение
 *   ключ: значение
 *   <a href="…">Ссылка</a>
 *
 * Проект указывается ВСЕГДА, даже в теме самого проекта — в теме
 * `🔴 incidents` сообщения четырёх проектов лежат вперемешку, и формат
 * должен быть один и тот же независимо от того, куда сообщение попало.
 */
import type { Item, NotifyEvent } from './events.ts';

/** Экранируется ВСЁ, что пришло снаружи — теги ставит только шаблон. */
export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Telegram режет сообщение на 4096 символах — режем сами, по возможности по
 * границе строки.
 *
 * Два подвоха, оба приводили к ТИХОЙ потере сообщения:
 * 1. Резать строго по последнему `\n` нельзя: если длинный кусок идёт одной
 *    строкой (стектрейс, вывод команды — самый частый `detail` у инцидента),
 *    последний перевод строки стоит ПЕРЕД ним, и содержимое выбрасывалось
 *    целиком — приходил заголовок без единого факта о поломке.
 * 2. Резать посреди HTML-тега или сущности тоже нельзя: Telegram отвечает
 *    `400 can't parse entities`, а 4xx мы считаем постоянной ошибкой и не
 *    повторяем — сообщение исчезало совсем.
 */
export const clampMessage = (text: string, limit = 4000): string => {
  if (text.length <= limit) {
    return text;
  }

  const cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf('\n');
  // По границе строки — только если так остаётся большая часть содержимого.
  let end = lastBreak > limit * 0.6 ? lastBreak : limit;

  // Не обрываемся внутри `<...>` и внутри `&...;` — иначе разметка ломается.
  const openTag = cut.lastIndexOf('<', end - 1);
  if (openTag !== -1 && cut.indexOf('>', openTag) === -1) {
    end = openTag;
  }
  const amp = cut.lastIndexOf('&', end - 1);
  if (amp !== -1 && end - amp <= 10 && cut.indexOf(';', amp) === -1) {
    end = amp;
  }

  const body = cut.slice(0, end);
  // Кламп мог отрезать закрывающие теги — добираем их, чтобы разметка сошлась.
  const tail = ['b', 'a', 'i', 'code']
    .filter((t) => {
      const opened = (body.match(new RegExp(`<${t}[ >]`, 'g')) ?? []).length;
      const closed = (body.match(new RegExp(`</${t}>`, 'g')) ?? []).length;

      return opened > closed;
    })
    .map((t) => `</${t}>`)
    .join('');

  return `${body}${tail}\n…`;
};

const header = (icon: string, title: string, project: string): string =>
  `${icon} <b>${esc(title)}</b> · ${esc(project)}`;

const kv = (label: string, value: string | number | undefined): string | null =>
  value === undefined || value === '' ? null : `${esc(label)}: ${esc(value)}`;

const link = (url: string | undefined, label: string): string | null =>
  url ? `<a href="${esc(url)}">${esc(label)}</a>` : null;

const join = (parts: Array<string | null>): string => parts.filter((p): p is string => p !== null).join('\n');

/** Список позиций — общий для `job` и `report`, чтобы они не разъехались. */
const bullets = (items: Item[] | undefined): string[] =>
  (items ?? []).map((it) => (it.url ? `• <a href="${esc(it.url)}">${esc(it.text)}</a>` : `• ${esc(it.text)}`));

type Renderer<E extends NotifyEvent> = (e: E) => string;

const renderDeploy: Renderer<Extract<NotifyEvent, { type: 'deploy' }>> = (e) => {
  const icon = e.status === 'ok' ? '✅' : '🔴';
  const title = e.status === 'ok' ? 'Деплой завершён' : 'Деплой упал';

  return join([
    header(icon, title, e.project),
    kv('коммит', e.commit),
    kv('куда', e.target),
    link(e.url, 'Открыть логи')
  ]);
};

const renderJob: Renderer<Extract<NotifyEvent, { type: 'job' }>> = (e) => {
  const icon = e.status === 'ok' ? '✅' : '🔴';
  const items = bullets(e.items);

  return join([
    header(icon, e.job, e.project),
    ...(e.stats ?? []).map(([label, value]) => kv(label, value)),
    items.length > 0 ? '' : null,
    ...items,
    kv('примечание', e.note),
    link(e.url, 'Подробнее')
  ]);
};

const renderReport: Renderer<Extract<NotifyEvent, { type: 'report' }>> = (e) => {
  const items = bullets(e.items);

  return join([
    header('📊', e.title, e.project),
    e.period ? esc(e.period) : null,
    e.period ? '' : null,
    ...e.lines.map(([label, value]) => kv(label, value)),
    items.length > 0 ? '' : null,
    ...items,
    link(e.url, 'Открыть отчёт')
  ]);
};

const renderCi: Renderer<Extract<NotifyEvent, { type: 'ci' }>> = (e) => {
  const icon = e.status === 'ok' ? '✅' : '🔴';
  const title = e.status === 'ok' ? 'CI зелёный' : 'CI упал';

  return join([
    header(icon, title, e.project),
    kv('ветка', e.branch),
    kv('коммит', e.commit),
    kv('автор', e.actor),
    link(e.url, 'Открыть логи')
  ]);
};

// Значок у каждого вида свой: в ленте Ops событие узнаётся по нему до чтения
// текста. Дублировать значок между видами нельзя — легенда закреплена в теме
// и обещает однозначность.
const PR_TITLES: Record<Extract<NotifyEvent, { type: 'pr' }>['action'], { icon: string; verb: string }> = {
  opened: { icon: '🔀', verb: 'открыт' },
  ready_for_review: { icon: '📤', verb: 'готов к ревью' },
  review_requested: { icon: '👁', verb: 'ждёт ревью' },
  approved: { icon: '👍', verb: 'ревью пройдено' },
  changes_requested: { icon: '📝', verb: 'запрошены правки' },
  merged: { icon: '✅', verb: 'смёржен' },
  closed: { icon: '⛔', verb: 'закрыт без слияния' }
};

const ISSUE_TITLES: Record<Extract<NotifyEvent, { type: 'issue' }>['action'], { icon: string; verb: string }> = {
  opened: { icon: '🆕', verb: 'заведена' },
  assigned: { icon: '🙋', verb: 'взята в работу' },
  closed: { icon: '☑️', verb: 'закрыта' }
};

const renderPr: Renderer<Extract<NotifyEvent, { type: 'pr' }>> = (e) => {
  const { icon, verb } = PR_TITLES[e.action];

  return join([
    header(icon, `PR #${e.number} ${verb}`, e.project),
    esc(e.title),
    kv('автор', e.author),
    kv('ревьюер', e.reviewer),
    link(e.url, 'Открыть PR')
  ]);
};

const renderIssue: Renderer<Extract<NotifyEvent, { type: 'issue' }>> = (e) => {
  const { icon, verb } = ISSUE_TITLES[e.action];

  return join([
    header(icon, `Задача #${e.number} ${verb}`, e.project),
    esc(e.title),
    kv('автор', e.author),
    kv('исполнитель', e.assignee),
    link(e.url, 'Открыть задачу')
  ]);
};

const renderIncident: Renderer<Extract<NotifyEvent, { type: 'incident' }>> = (e) =>
  join([header('🚨', 'Инцидент', e.project), esc(e.title), e.detail ? esc(e.detail) : null, link(e.url, 'Подробнее')]);

const renderHeartbeatMiss: Renderer<Extract<NotifyEvent, { type: 'heartbeat_miss' }>> = (e) =>
  join([
    header('🔴', `Не отметилась: ${e.job}`, e.project),
    kv('последний раз', e.lastSeen),
    kv('ожидалось', e.expected)
  ]);

const RENDERERS: { [K in NotifyEvent['type']]: Renderer<Extract<NotifyEvent, { type: K }>> } = {
  deploy: renderDeploy,
  job: renderJob,
  report: renderReport,
  ci: renderCi,
  pr: renderPr,
  issue: renderIssue,
  incident: renderIncident,
  heartbeat_miss: renderHeartbeatMiss
};

/** Рендерит событие в готовый HTML-текст, обрезанный под лимит Telegram. */
export const render = (e: NotifyEvent): string => {
  const renderer = RENDERERS[e.type] as Renderer<typeof e> | undefined;

  // Прикрывает путь `--json` и вызовы из JS без типов: там `type` — обычная
  // строка, и неизвестное значение роняло процесс через `renderer is not a
  // function`. Падать из-за уведомления нельзя.
  if (typeof renderer !== 'function') {
    throw new Error(`неизвестный тип события: ${String(e.type)}`);
  }

  return clampMessage(renderer(e));
};
