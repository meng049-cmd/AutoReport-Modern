function isDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith('0000')) return false;
  const date = new Date(day + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === day;
}

function validPeriod(start, end) {
  return isDay(start) && isDay(end) && start <= end ? {start, end} : null;
}

function periodFromFilename(name) {
  const fullDates = name.match(/_(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})_不良分析\.xlsx$/i);
  if (fullDates) return validPeriod(fullDates[1], fullDates[2]);

  const compactDates = name.match(/^(\d{4})(?:_w(\d{1,2})|-[\d-]+).*?_(\d{2})(\d{2})-(\d{2})(\d{2})_不良分析\.xlsx$/i);
  if (!compactDates) return null;
  const [, year, week, startMonth, startDay, endMonth, endDay] = compactDates;
  // Early January can belong to the final week numbered in the previous year.
  const startYear = Number(year) + (Number(week) >= 52 && startMonth === '01' ? 1 : 0);
  const endYear = startYear + (endMonth + endDay < startMonth + startDay ? 1 : 0);
  return validPeriod(startYear + '-' + startMonth + '-' + startDay, endYear + '-' + endMonth + '-' + endDay);
}

export function reportEntryPeriod(entry) {
  const saved = entry.analysisPeriod, requested = entry.analysisInputs?.options?.period;
  return validPeriod(saved?.start, saved?.end) || validPeriod(requested?.start_date, requested?.end_date) ||
    periodFromFilename(entry.name || '');
}
