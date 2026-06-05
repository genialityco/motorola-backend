import { Injectable, Logger } from '@nestjs/common';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { FirebaseService } from '../firebase/firebase.service';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly ses: SESClient;
  private readonly from: string;
  private adminCache: { emails: string[]; expiresAt: number } | null = null;

  constructor(private readonly firebase: FirebaseService) {
    this.from = process.env.SES_FROM_EMAIL ?? '';
    this.ses = new SESClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
      },
    });
  }

  private async getAdminEmails(): Promise<string[]> {
    const now = Date.now();
    if (this.adminCache && this.adminCache.expiresAt > now) {
      return this.adminCache.emails;
    }
    const result = await this.firebase.auth.listUsers(1000);
    const emails = result.users
      .filter((u) => u.customClaims?.['role'] === 'admin' && u.email)
      .map((u) => u.email!);
    this.adminCache = { emails, expiresAt: now + 5 * 60 * 1000 };
    return emails;
  }

  private async getGestorEmails(gestorIds: string[]): Promise<string[]> {
    if (!gestorIds.length) return [];
    const docs = await Promise.all(
      gestorIds.map((id) => this.firebase.db.collection('gestor').doc(id).get()),
    );
    return docs
      .filter((d) => d.exists && d.data()?.email)
      .map((d) => d.data()!.email as string);
  }

  private async send(to: string[], subject: string, html: string): Promise<void> {
    if (!to.length || !this.from) return;
    await this.ses.send(
      new SendEmailCommand({
        Source: this.from,
        Destination: { ToAddresses: to },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' } },
        },
      }),
    );
  }

  async notifyTicketCreated(
    ticketData: Record<string, unknown>,
    assignedGestorIds: string[],
  ): Promise<void> {
    const [adminEmails, gestorEmails] = await Promise.all([
      this.getAdminEmails(),
      this.getGestorEmails(assignedGestorIds),
    ]);

    const recipients = [...new Set([...adminEmails, ...gestorEmails])];
    if (!recipients.length) return;

    const ticketNumber = String(ticketData.ticketNumber ?? '');
    const reporter = (ticketData.reporter as Record<string, string>) ?? {};
    const subject = `Nuevo ticket creado - ${ticketNumber}`;
    const html = this.buildTicketCreatedHtml(ticketNumber, reporter, ticketData);

    await this.send(recipients, subject, html).catch((err) =>
      this.logger.error('Error enviando email de ticket creado', err),
    );
  }

  async notifyStatusChanged(
    ticketData: Record<string, unknown>,
    prevStatus: string,
    newStatus: string,
  ): Promise<void> {
    const assignedGestorIds = (ticketData.assignedGestorIds as string[]) ?? [];
    const [adminEmails, gestorEmails] = await Promise.all([
      this.getAdminEmails(),
      this.getGestorEmails(assignedGestorIds),
    ]);

    const recipients = [...new Set([...adminEmails, ...gestorEmails])];
    if (!recipients.length) return;

    const ticketNumber = String(ticketData.ticketNumber ?? '');
    const subject = `Ticket ${ticketNumber} - Cambio a ${newStatus}`;
    const html = this.buildStatusChangedHtml(ticketNumber, prevStatus, newStatus, ticketData);

    await this.send(recipients, subject, html).catch((err) =>
      this.logger.error('Error enviando email de cambio de estado', err),
    );
  }

  private buildTicketCreatedHtml(
    ticketNumber: string,
    reporter: Record<string, string>,
    ticketData: Record<string, unknown>,
  ): string {
    const extraFields = (ticketData.extraFields as Record<string, unknown>) ?? {};
    const fieldRows = Object.entries(extraFields)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 12px;color:#666;border-bottom:1px solid #f0f0f0">${k}</td>` +
          `<td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">${v}</td></tr>`,
      )
      .join('');

    return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#1a1a2e;padding:24px 32px">
    <h1 style="color:#fff;margin:0;font-size:20px">Nuevo ticket creado</h1>
  </div>
  <div style="padding:24px 32px">
    <table style="width:100%;border-collapse:collapse">
      <tr style="background:#f8f8f8">
        <td style="padding:6px 12px;color:#666;border-bottom:1px solid #f0f0f0">Número</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0"><strong>${ticketNumber}</strong></td>
      </tr>
      <tr>
        <td style="padding:6px 12px;color:#666;border-bottom:1px solid #f0f0f0">Reportado por</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">${reporter['name'] ?? ''} (${reporter['phone'] ?? ''})</td>
      </tr>
      <tr style="background:#f8f8f8">
        <td style="padding:6px 12px;color:#666;border-bottom:1px solid #f0f0f0">Estado</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">REPORTADO</td>
      </tr>
      ${fieldRows}
    </table>
  </div>
</div>`;
  }

  private buildStatusChangedHtml(
    ticketNumber: string,
    prevStatus: string,
    newStatus: string,
    ticketData: Record<string, unknown>,
  ): string {
    const reporter = (ticketData.reporter as Record<string, string>) ?? {};
    const date = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

    return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#1a1a2e;padding:24px 32px">
    <h1 style="color:#fff;margin:0;font-size:20px">Cambio de estado en ticket</h1>
  </div>
  <div style="padding:24px 32px">
    <table style="width:100%;border-collapse:collapse">
      <tr style="background:#f8f8f8">
        <td style="padding:6px 12px;color:#666;border-bottom:1px solid #f0f0f0">Número</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0"><strong>${ticketNumber}</strong></td>
      </tr>
      <tr>
        <td style="padding:6px 12px;color:#666;border-bottom:1px solid #f0f0f0">Reportado por</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">${reporter['name'] ?? ''} (${reporter['phone'] ?? ''})</td>
      </tr>
      <tr style="background:#f8f8f8">
        <td style="padding:6px 12px;color:#666;border-bottom:1px solid #f0f0f0">Estado anterior</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">${prevStatus}</td>
      </tr>
      <tr>
        <td style="padding:6px 12px;color:#666;border-bottom:1px solid #f0f0f0">Estado nuevo</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0"><strong style="color:#1a1a2e">${newStatus}</strong></td>
      </tr>
      <tr style="background:#f8f8f8">
        <td style="padding:6px 12px;color:#666">Fecha</td>
        <td style="padding:6px 12px">${date}</td>
      </tr>
    </table>
  </div>
</div>`;
  }
}
