const BEIJING_TIME_ZONE = "Asia/Shanghai";

function resolveDate(value: string | Date): Date | undefined {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function beijingParts(date: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BEIJING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  return formatter.formatToParts(date).reduce<Record<string, string>>((parts, part) => {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
    return parts;
  }, {});
}

export function formatBeijingDateTime(value: string | Date): string {
  const date = resolveDate(value);
  if (!date) {
    return value instanceof Date ? value.toISOString() : value;
  }

  const parts = beijingParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} 北京时间`;
}

export function formatBeijingFileTimestamp(value: string | Date): string {
  const date = resolveDate(value);
  if (!date) {
    return "unknown-time";
  }

  const parts = beijingParts(date);
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
}
