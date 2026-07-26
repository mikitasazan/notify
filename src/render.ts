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
import type { NotifyEvent } from './events.ts';

/** Экранируется ВСЁ, что пришло снаружи — теги ставит только шаблон. */
export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Telegram режет сообщение на 4096 символах — режем сами по границе строки. */
export const clampMessage = (text: string, limit = 4000): string => {
  if (text.length <= limit) {
    return text;
  }

  const cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf('\n');

  return `${cut.slice(0, lastBreak > 0 ? lastBreak : limit)}\n…`;
};

const header = (icon: string, title: string, project: string): string =>
  `${icon} <b>${esc(title)}</b> · ${esc(project)}`;

const kv = (label: string, value: string | number | undefined): string | null =>
  value === undefined || value === '' ? null : `${esc(label)}: ${esc(value)}`;

const link = (url: string | undefined, label: string): string | null =>
  url ? `<a href="${esc(url)}">${esc(label)}</a>` : null;

const join = (parts: Array<string | null>): string => parts.filter((p): p is string => p !== null).join('\n');

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

  return join([
    header(icon, e.job, e.project),
    ...(e.stats ?? []).map(([label, value]) => kv(label, value)),
    kv('примечание', e.note),
    link(e.url, 'Подробнее')
  ]);
};

const renderReport: Renderer<Extract<NotifyEvent, { type: 'report' }>> = (e) =>
  join([
    header('📊', e.title, e.project),
    e.period ? esc(e.period) : null,
    e.period ? '' : null,
    ...e.lines.map(([label, value]) => kv(label, value)),
    link(e.url, 'Открыть отчёт')
  ]);

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

const PR_TITLES: Record<Extract<NotifyEvent, { type: 'pr' }>['action'], { icon: string; verb: string }> = {
  opened: { icon: '🔀', verb: 'открыт' },
  review_requested: { icon: '👁', verb: 'ждёт ревью' },
  merged: { icon: '✅', verb: 'смёржен' }
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
  incident: renderIncident,
  heartbeat_miss: renderHeartbeatMiss
};

/** Рендерит событие в готовый HTML-текст, обрезанный под лимит Telegram. */
export const render = (e: NotifyEvent): string => {
  const renderer = RENDERERS[e.type] as Renderer<typeof e>;

  return clampMessage(renderer(e));
};
