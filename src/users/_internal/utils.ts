export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, obj);
}

export interface AssignmentRule {
  fieldKey: string;
  fieldValues: string[];
}

export function ruleMatches(extraFields: Record<string, unknown>, rule: AssignmentRule): boolean {
  const fieldValue = getNestedValue(extraFields, rule.fieldKey);
  const strValue = String(fieldValue ?? '').trim().toUpperCase();
  if (strValue.length === 0) return false;
  return rule.fieldValues.some((v) => v.trim().toUpperCase() === strValue);
}

export function rulesMatch(extraFields: Record<string, unknown>, rules: AssignmentRule[]): boolean {
  return rules.length > 0 && rules.some((rule) => ruleMatches(extraFields, rule));
}
