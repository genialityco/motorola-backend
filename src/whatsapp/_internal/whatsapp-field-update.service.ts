import { Injectable } from '@nestjs/common';
import { BotConfigService, TicketField, interpolate } from '../../bot-config/bot-config.service';
import { COLLECTIONS, FirebaseService } from '../../firebase/firebase.service';
import { WhatsappFormattingService } from './whatsapp-formatting.service';
import { normalizeText } from './flows/helpers';

@Injectable()
export class WhatsappFieldUpdateService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
    private readonly formatting: WhatsappFormattingService,
  ) {}

  async processFieldUpdate(
    ticketId: string,
    body: string,
    fieldType: string,
    fieldOptions: string[],
    fieldNormalize: boolean | undefined,
    fieldAllowOther: boolean,
    fieldOtherLabel: string | null,
    send: (msg: string) => Promise<void>,
    onListOtherResponse?: () => Promise<void>,
  ): Promise<{ newValue?: string; isOtherResponse?: boolean }> {
    if (!body) {
      await send('Por favor ingresa el nuevo valor.');
      return {};
    }

    if (fieldType === 'list' && fieldOptions.length > 0) {
      const optIdx = parseInt(body) - 1;
      const totalOpts = fieldAllowOther ? fieldOptions.length + 1 : fieldOptions.length;

      if (isNaN(optIdx) || optIdx < 0 || optIdx >= totalOpts) {
        const opts = fieldOptions.map((o, i) => `${i + 1}. ${o}`).join('\n');
        const otherLine = fieldAllowOther ? `\n${fieldOptions.length + 1}. Otro` : '';
        await send(`Opción no válida:\n${opts}${otherLine}`);
        return {};
      }

      if (fieldAllowOther && optIdx === fieldOptions.length) {
        if (onListOtherResponse) await onListOtherResponse();
        return { isOtherResponse: true };
      }

      return { newValue: fieldOptions[optIdx] };
    }

    if (fieldType === 'boolean') {
      const lower = body.toLowerCase();
      if (['si', 'sí', '1', 'yes', 's'].includes(lower)) {
        return { newValue: 'true' };
      } else if (['no', '2', 'n'].includes(lower)) {
        return { newValue: 'false' };
      } else {
        await send('Por favor responde *Sí* (1) o *No* (2).');
        return {};
      }
    }

    const newValue = fieldNormalize ? normalizeText(body) : body.trim();
    return { newValue };
  }

  async saveFieldUpdateAndNotify(
    ticketId: string,
    fieldKey: string,
    newValue: string,
    ticketData: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const db = this.firebase.db;
    await db.collection(COLLECTIONS.TICKETS).doc(ticketId).update({
      [`extraFields.${fieldKey}`]: newValue,
      'timestamps.updatedAt': Date.now(),
    });

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const extraVarsEdit = this.formatting.flattenExtraFieldsForInterpolation(
      (ticketData.extraFields as Record<string, unknown>) || {},
    );
    const editMsg = interpolate(
      msgs?.ticketCreated ?? '✅ Ticket *{ticketNumber}* {action} exitosamente.\n\nTe notificaremos cuando haya actualizaciones de estados.',
      { ticketNumber: String(ticketData.ticketNumber ?? ''), action: 'editado', ...extraVarsEdit },
    );
    await send(editMsg);
  }
}
