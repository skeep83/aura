// «Вечер Искры» — ежедневное событие по расписанию с короткими раундами.
// Время задаётся в часовом поясе аудитории (по умолчанию Москва, UTC+3).
const MIN = 60 * 1000;

export class EventSchedule {
  constructor({ time = '21:00', tzOffsetHours = 3, minutes = 60, roundSeconds = 180, remindBeforeMin = 5 } = {}) {
    const [h, m] = String(time).split(':').map(Number);
    this.startMinute = (h || 0) * 60 + (m || 0);
    this.tzMs = tzOffsetHours * 60 * MIN;
    this.durationMs = minutes * MIN;
    this.roundMs = roundSeconds * 1000;
    this.remindMs = remindBeforeMin * MIN;
  }

  // Начало ближайшего (текущего или следующего) события, UTC ms
  startFor(now = Date.now()) {
    const local = now + this.tzMs;
    const dayStart = local - (local % (24 * 60 * MIN));
    let start = dayStart + this.startMinute * MIN - this.tzMs;
    // Вчерашнее событие ещё идёт (перешло через полночь)
    if (now < start && now < start - 24 * 60 * MIN + this.durationMs) return start - 24 * 60 * MIN;
    if (now >= start + this.durationMs) start += 24 * 60 * MIN;
    return start;
  }

  state(now = Date.now()) {
    const startsAt = this.startFor(now);
    const endsAt = startsAt + this.durationMs;
    return { active: now >= startsAt && now < endsAt, startsAt, endsAt, roundMs: this.roundMs };
  }

  // Ключ напоминания: один раз за событие, в окне remindBeforeMin до старта
  reminderDue(now = Date.now()) {
    const startsAt = this.startFor(now);
    return now >= startsAt - this.remindMs && now < startsAt ? String(startsAt) : null;
  }
}

// Местная дата YYYY-MM-DD для серий дней
export function localDay(now, tzOffsetHours) {
  return new Date(now + tzOffsetHours * 60 * MIN).toISOString().slice(0, 10);
}
