const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function formatDateKey(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function localInputValue(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function addCalendarDays(date: string, days: number): string {
  const match = DATE_PATTERN.exec(date);
  if (!match || !Number.isSafeInteger(days)) throw new RangeError('Invalid calendar date');
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return value.toISOString().slice(0, 10);
}

export function localDateTimeToIso(value: string, timeZone: string): string {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value);
  if (!match) throw new RangeError('Invalid local date and time');
  const desired = {
    year: match[1], month: match[2], day: match[3], hour: match[4], minute: match[5]
  };
  const desiredUtc = Date.UTC(Number(desired.year), Number(desired.month) - 1, Number(desired.day), Number(desired.hour), Number(desired.minute));
  let candidate = desiredUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = zonedParts(new Date(candidate), timeZone);
    const renderedUtc = Date.UTC(Number(rendered.year), Number(rendered.month) - 1, Number(rendered.day), Number(rendered.hour), Number(rendered.minute));
    candidate += desiredUtc - renderedUtc;
  }

  const result = new Date(candidate);
  const rendered = zonedParts(result, timeZone);
  if (Object.entries(desired).some(([key, expected]) => rendered[key as keyof typeof rendered] !== expected)) {
    throw new RangeError('Local date and time does not exist in this timezone');
  }
  return result.toISOString();
}

function zonedParts(date: Date, timeZone: string): Record<'year' | 'month' | 'day' | 'hour' | 'minute', string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return {year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute')};
}
