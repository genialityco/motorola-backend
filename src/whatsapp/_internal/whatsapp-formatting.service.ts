import { Injectable } from '@nestjs/common';
import { BotConfigService, TicketField } from '../../bot-config/bot-config.service';
import { getNestedValue } from './flows/helpers';

interface PendingTicket {
  id: string;
  ticketNumber: string;
  status: string;
  extraFields?: Record<string, string | string[]>;
  createdAt?: number;
  updatedAt?: number;
}

@Injectable()
export class WhatsappFormattingService {
  constructor(private readonly botConfig: BotConfigService) {}

  buildFieldQuestion(field: TicketField): string {
    const prompt = field.question?.trim() || field.placeholder?.trim() || field.label;
    if (field.type === 'list' && field.options && field.options.length > 0) {
      const opts = field.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
      const otherLine = field.allowOther ? `\n${field.options.length + 1}. Otro` : '';
      return `${prompt}\n${opts}${otherLine}`;
    }
    if (field.type === 'boolean') {
      return `${prompt}\n1. Sí\n2. No`;
    }
    if (field.type === 'photo') {
      return `${prompt}\nEnvía las fotos y escribe *listo* cuando hayas terminado.`;
    }
    return prompt;
  }

  formatTicketsListDetailed(tickets: PendingTicket[], allFields: TicketField[], template?: string): string {
    const textFields = allFields.filter(f => f.type !== 'photo' && f.type !== 'video');
    return tickets
      .map((t, i) => {
        const dateStr = t.createdAt
          ? new Date(t.createdAt).toLocaleDateString('es-CO')
          : 'Sin fecha';

        if (template) {
          const extraVars = this.flattenExtraFieldsForInterpolation(
            (t.extraFields as Record<string, unknown>) || {},
          );
          const vars: Record<string, string> = {
            index: String(i + 1),
            ticketNumber: t.ticketNumber,
            estado: t.status,
            fecha: dateStr,
            ...extraVars,
          };
          const rendered = template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
          return rendered.split('\n').filter(line => line.trim() !== '').join('\n');
        }

        const lines = [
          `${i + 1}. 📋 *${t.ticketNumber}*`,
          `   Estado: ${t.status}`,
          `   Fecha: ${dateStr}`,
        ];
        for (const field of textFields) {
          const value = getNestedValue((t.extraFields as Record<string, unknown>) || {}, field.key);
          if (value && typeof value === 'string') {
            const display = value === 'true' ? 'Sí' : value === 'false' ? 'No' : value;
            lines.push(`   ${field.label}: ${display}`);
          }
        }
        return lines.join('\n');
      })
      .join('\n\n');
  }

  flattenExtraFieldsForInterpolation(extraFields: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {};
    const process = (obj: Record<string, unknown>, prefix: string) => {
      for (const [key, val] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof val === 'string') {
          result[fullKey] = val;
          result[key] = val;
          const underscored = fullKey.replace(/\./g, '_');
          if (underscored !== fullKey) result[underscored] = val;
        } else if (Array.isArray(val)) {
          result[key] = `${val.length} elemento(s)`;
          result[fullKey] = result[key];
        } else if (val && typeof val === 'object') {
          process(val as Record<string, unknown>, fullKey);
        }
      }
    };
    process(extraFields, '');
    return result;
  }
}
