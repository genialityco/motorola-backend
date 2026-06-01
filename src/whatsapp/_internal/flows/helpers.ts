/**
 * Helpers compartidos para flujos de WhatsApp
 */

export function normalizeText(text: string): string {
  return text
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, obj);
}

export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

