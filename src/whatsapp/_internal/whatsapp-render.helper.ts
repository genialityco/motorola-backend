import { Injectable } from '@nestjs/common';
import { COLLECTIONS, FirebaseService } from '../../firebase/firebase.service';
import { TicketField } from '../../bot-config/bot-config.service';
import { PendingTicket, flattenExtraFieldsForInterpolation, getNestedValue } from './utils';

@Injectable()
export class WhatsappRenderHelper {
  constructor(private readonly firebase: FirebaseService) {}

  buildFieldQuestion(field: TicketField): string {
    const prompt = field.question?.trim() || field.placeholder?.trim() || field.label;
    if (field.type === 'list' && field.options && field.options.length > 0) {
      const opts = field.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
      const otherLine = field.allowOther ? `\n${field.options.length + 1}. Otro` : '';
      return `${prompt}\n${opts}${otherLine}`;
    }
    if (field.type === 'boolean') return `${prompt}\n1. Sí\n2. No`;
    if (field.type === 'photo') return `${prompt}\nEnvía las fotos y escribe *listo* cuando hayas terminado.`;
    return prompt;
  }

  formatTicketsListDetailed(
    tickets: PendingTicket[],
    allFields: TicketField[],
    template?: string,
  ): string {
    const textFields = allFields.filter(f => f.type !== 'photo' && f.type !== 'video');
    return tickets
      .map((t, i) => this.formatSingleTicketLine(t, i, textFields, template))
      .join('\n\n');
  }

  async getTicketsByPhone(phone: string): Promise<PendingTicket[]> {
    const snap = await this.firebase.db
      .collection(COLLECTIONS.TICKETS)
      .where('reporter.phone', '==', phone)
      .get();
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ticketNumber: data.ticketNumber as string,
          status: data.status as string,
          extraFields: (data.extraFields as Record<string, string | string[]>) || {},
          createdAt: data.timestamps?.createdAt as number | undefined,
          updatedAt: data.timestamps?.updatedAt as number | undefined,
        };
      })
      .filter((t) => t.status !== 'ARCHIVADO' && t.status !== 'FINALIZADO');
  }

  private formatSingleTicketLine(
    t: PendingTicket, i: number, textFields: TicketField[], template?: string,
  ): string {
    const dateStr = t.createdAt
      ? new Date(t.createdAt).toLocaleDateString('es-CO')
      : 'Sin fecha';
    if (template) {
      const extraVars = flattenExtraFieldsForInterpolation(
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
  }
}
