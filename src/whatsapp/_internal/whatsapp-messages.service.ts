import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WhatsappMessagesService {
  private readonly logger = new Logger(WhatsappMessagesService.name);

  async callWhatsAppApi(payload: Record<string, unknown>, logLabel: string) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;

    if (!token || !phoneId) {
      this.logger.warn('Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_ID');
      return;
    }

    const res = await fetch(
      `https://graph.facebook.com/v17.0/${phoneId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) {
      this.logger.error(`Error ${logLabel}: ${res.status} ${await res.text()}`);
    }
  }

  async sendMessage(to: string, text: string) {
    await this.callWhatsAppApi(
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      'enviando WhatsApp',
    );
  }

  async sendImageMessage(to: string, imageUrl: string, caption?: string) {
    await this.callWhatsAppApi(
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl, ...(caption ? { caption } : {}) },
      },
      'enviando imagen WhatsApp',
    );
  }
}
