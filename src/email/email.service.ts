import { Injectable, Logger } from '@nestjs/common';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { FirebaseService } from '../firebase/firebase.service';

export type EmailEvent = 'created' | 'statusChanged';

export interface EmailRecipient {
  id: string; // uid (admin/gestor)
  email: string;
  name: string;
  type: 'admin' | 'gestor';
  events: Record<EmailEvent, boolean>;
}

export interface EmailTemplate {
  subject: string;
  body: string;
}

export interface EmailConfig {
  notifyAssignedGestores: boolean;
  recipients: EmailRecipient[];
  templates: Record<EmailEvent, EmailTemplate>;
}

export interface RecipientOption {
  id: string;
  email: string;
  name: string;
  type: 'admin' | 'gestor';
}

export const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  notifyAssignedGestores: true,
  recipients: [],
  templates: {
    created: {
      subject: 'Nuevo ticket creado - {ticketNumber}',
      body:
        'Se ha creado el ticket {ticketNumber}.\n\n' +
        'Reportado por: {reporterName} ({reporterPhone})\n' +
        'Estado: {status}',
    },
    statusChanged: {
      subject: 'Ticket {ticketNumber} - Cambio a {newStatus}',
      body:
        'El estado del ticket {ticketNumber} ha cambiado.\n\n' +
        'Estado anterior: {prevStatus}\n' +
        'Estado nuevo: {newStatus}\n\n' +
        'Reportado por: {reporterName} ({reporterPhone})\n' +
        'Fecha: {date}',
    },
  },
};

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([\w.]+)\}/g, (_, key) =>
    vars[key] !== undefined ? vars[key] : `{${key}}`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly ses: SESClient;
  private readonly from: string;
  private configCache: { config: EmailConfig; expiresAt: number } | null = null;

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

  // ── Configuration ──────────────────────────────────────────────────────────

  async getConfig(): Promise<EmailConfig> {
    const now = Date.now();
    if (this.configCache && this.configCache.expiresAt > now) {
      return this.configCache.config;
    }
    const snap = await this.firebase.db.collection('bot_config').doc('email').get();
    const data = snap.exists ? (snap.data() as Partial<EmailConfig>) : {};
    const config: EmailConfig = {
      notifyAssignedGestores:
        data.notifyAssignedGestores ?? DEFAULT_EMAIL_CONFIG.notifyAssignedGestores,
      recipients: Array.isArray(data.recipients) ? data.recipients : DEFAULT_EMAIL_CONFIG.recipients,
      templates: {
        created: { ...DEFAULT_EMAIL_CONFIG.templates.created, ...(data.templates?.created ?? {}) },
        statusChanged: {
          ...DEFAULT_EMAIL_CONFIG.templates.statusChanged,
          ...(data.templates?.statusChanged ?? {}),
        },
      },
    };
    this.configCache = { config, expiresAt: now + 60_000 };
    return config;
  }

  async updateConfig(config: Partial<EmailConfig>): Promise<EmailConfig> {
    await this.firebase.db.collection('bot_config').doc('email').set(config, { merge: true });
    this.configCache = null;
    return this.getConfig();
  }

  /** Lists admins (from Firebase Auth) and gestores (from Firestore) selectable as recipients. */
  async listRecipientOptions(): Promise<RecipientOption[]> {
    const [authResult, gestorSnap] = await Promise.all([
      this.firebase.auth.listUsers(1000),
      this.firebase.db.collection('gestor').get(),
    ]);

    const admins: RecipientOption[] = authResult.users
      .filter((u) => u.customClaims?.['role'] === 'admin' && u.email)
      .map((u) => ({
        id: u.uid,
        email: u.email!,
        name: u.displayName || u.email!,
        type: 'admin' as const,
      }));

    const gestores: RecipientOption[] = gestorSnap.docs
      .map((d) => d.data() as { uid?: string; email?: string; name?: string })
      .filter((g) => g.email)
      .map((g) => ({
        id: g.uid ?? g.email!,
        email: g.email!,
        name: g.name || g.email!,
        type: 'gestor' as const,
      }));

    return [...admins, ...gestores];
  }

  // ── Recipient resolution ─────────────────────────────────────────────────────

  private async getAssignedGestorEmails(gestorIds: string[]): Promise<string[]> {
    if (!gestorIds.length) return [];
    const docs = await Promise.all(
      gestorIds.map((id) => this.firebase.db.collection('gestor').doc(id).get()),
    );
    return docs
      .filter((d) => d.exists && d.data()?.email)
      .map((d) => d.data()!.email as string);
  }

  private async resolveRecipients(
    config: EmailConfig,
    event: EmailEvent,
    assignedGestorIds: string[],
  ): Promise<string[]> {
    const configured = config.recipients
      .filter((r) => r.events?.[event] && r.email)
      .map((r) => r.email);

    const assigned = config.notifyAssignedGestores
      ? await this.getAssignedGestorEmails(assignedGestorIds)
      : [];

    return [...new Set([...configured, ...assigned])];
  }

  // ── Sending ──────────────────────────────────────────────────────────────────

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
    const config = await this.getConfig();
    const recipients = await this.resolveRecipients(config, 'created', assignedGestorIds);
    if (!recipients.length) return;

    const reporter = (ticketData.reporter as Record<string, string>) ?? {};
    const vars = this.buildVars(ticketData, {
      status: 'REPORTADO',
      reporterName: reporter['name'] ?? '',
      reporterPhone: reporter['phone'] ?? '',
    });

    const tpl = config.templates.created;
    const subject = interpolate(tpl.subject, vars);
    const html = this.wrapHtml('Nuevo ticket creado', interpolate(tpl.body, vars));

    await this.send(recipients, subject, html).catch((err) =>
      this.logger.error('Error enviando email de ticket creado', err),
    );
  }

  async notifyStatusChanged(
    ticketData: Record<string, unknown>,
    prevStatus: string,
    newStatus: string,
  ): Promise<void> {
    const config = await this.getConfig();
    const assignedGestorIds = (ticketData.assignedGestorIds as string[]) ?? [];
    const recipients = await this.resolveRecipients(config, 'statusChanged', assignedGestorIds);
    if (!recipients.length) return;

    const reporter = (ticketData.reporter as Record<string, string>) ?? {};
    const vars = this.buildVars(ticketData, {
      prevStatus,
      newStatus,
      reporterName: reporter['name'] ?? '',
      reporterPhone: reporter['phone'] ?? '',
    });

    const tpl = config.templates.statusChanged;
    const subject = interpolate(tpl.subject, vars);
    const html = this.wrapHtml('Cambio de estado en ticket', interpolate(tpl.body, vars));

    await this.send(recipients, subject, html).catch((err) =>
      this.logger.error('Error enviando email de cambio de estado', err),
    );
  }

  /** Builds the interpolation variables: common ticket fields + flattened extraFields (dot-notation). */
  private buildVars(
    ticketData: Record<string, unknown>,
    extra: Record<string, string>,
  ): Record<string, string> {
    const vars: Record<string, string> = {
      ticketNumber: String(ticketData.ticketNumber ?? ''),
      date: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
      ...extra,
    };

    const extraFields = (ticketData.extraFields as Record<string, unknown>) ?? {};
    this.flattenFields(extraFields, '', vars);
    return vars;
  }

  /** Recursively flattens extraFields into dot-notation keys (e.g. `novelty.type`) for interpolation. */
  private flattenFields(obj: Record<string, unknown>, prefix: string, out: Record<string, string>): void {
    for (const [k, value] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.flattenFields(value as Record<string, unknown>, key, out);
      } else if (typeof value === 'string' || typeof value === 'number') {
        out[key] = String(value);
      }
    }
  }

  /** Wraps the (plain-text, {var}-interpolated) body in the styled email layout. */
  private wrapHtml(title: string, body: string): string {
    const bodyHtml = escapeHtml(body).replace(/\n/g, '<br/>');
    return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
  <div style="background:#1a1a2e;padding:24px 32px">
    <h1 style="color:#fff;margin:0;font-size:20px">${escapeHtml(title)}</h1>
  </div>
  <div style="padding:24px 32px;color:#1a1a1a;font-size:14px;line-height:1.6">
    ${bodyHtml}
  </div>
</div>`;
  }
}
