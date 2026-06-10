import { Injectable, Logger } from '@nestjs/common';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { FirebaseService } from '../firebase/firebase.service';

export type EmailEvent = 'created' | 'statusChanged';

export interface EmailTemplate {
  subject: string;
  body: string;
}

export interface EmailConfig {
  templates: Record<EmailEvent, EmailTemplate>;
}

export interface RecipientOption {
  id: string;
  email: string;
  name: string;
  type: 'admin' | 'gestor';
}

export const DEFAULT_EMAIL_CONFIG: EmailConfig = {
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
    if (this.from) {
      this.logger.log(`SES inicializado — remitente: ${this.from}, región: ${process.env.AWS_REGION ?? 'us-east-1'}`);
    } else {
      this.logger.error('SES_FROM_EMAIL no está definido en .env — los emails no se enviarán');
    }
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  async getConfig(): Promise<EmailConfig> {
    const now = Date.now();
    if (this.configCache && this.configCache.expiresAt > now) {
      this.logger.debug('getConfig: usando caché');
      return this.configCache.config;
    }
    const snap = await this.firebase.db.collection('bot_config').doc('email').get();
    this.logger.debug(`getConfig: doc existe=${snap.exists}`);
    const data = snap.exists ? (snap.data() as Partial<EmailConfig>) : {};
    const config: EmailConfig = {
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

  /** Lists admins (from Firebase Auth) selectable as per-ticket email recipients (CC). */
  async listAdmins(): Promise<RecipientOption[]> {
    const authResult = await this.firebase.auth.listUsers(1000);
    return authResult.users
      .filter((u) => u.customClaims?.['role'] === 'admin' && u.email)
      .map((u) => ({
        id: u.uid,
        email: u.email!,
        name: u.displayName || u.email!,
        type: 'admin' as const,
      }));
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

  /**
   * Destinatarios de un correo de ticket: los gestores asignados (por las reglas
   * del ticket) más los administradores que el gestor marcó como copia en el
   * propio ticket (`notifyAdminEmails`).
   */
  private async resolveRecipients(
    assignedGestorIds: string[],
    adminEmails: string[],
  ): Promise<string[]> {
    const assigned = await this.getAssignedGestorEmails(assignedGestorIds);
    const result = [...new Set([...assigned, ...adminEmails.filter(Boolean)])];
    this.logger.log(
      `resolveRecipients: gestores=${JSON.stringify(assigned)} adminsCopia=${JSON.stringify(adminEmails)} → total=${result.length}`,
    );
    return result;
  }

  // ── Sending ──────────────────────────────────────────────────────────────────

  private async send(to: string[], subject: string, html: string): Promise<void> {
    if (!this.from) {
      this.logger.warn('send: SES_FROM_EMAIL no está configurado — email omitido');
      return;
    }
    if (!to.length) {
      this.logger.warn('send: lista de destinatarios vacía — email omitido');
      return;
    }
    this.logger.log(`send: enviando vía SES desde="${this.from}" a=${JSON.stringify(to)} asunto="${subject}"`);
    try {
      const result = await this.ses.send(
        new SendEmailCommand({
          Source: this.from,
          Destination: { ToAddresses: to },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Html: { Data: html, Charset: 'UTF-8' } },
          },
        }),
      );
      this.logger.log(`send: SES aceptó el mensaje — MessageId=${result.MessageId}`);
    } catch (err) {
      this.logger.error(`send: SES rechazó el mensaje — ${(err as Error).message}`, (err as Error).stack);
      throw err;
    }
  }

  async notifyTicketCreated(
    ticketData: Record<string, unknown>,
    assignedGestorIds: string[],
  ): Promise<void> {
    this.logger.log(`notifyTicketCreated: ticket=${ticketData.ticketNumber} gestoresAsignados=${JSON.stringify(assignedGestorIds)}`);
    const config = await this.getConfig();
    const adminEmails = (ticketData.notifyAdminEmails as string[]) ?? [];
    const recipients = await this.resolveRecipients(assignedGestorIds, adminEmails);
    if (!recipients.length) {
      this.logger.warn('notifyTicketCreated: sin destinatarios — email omitido');
      return;
    }

    const reporter = (ticketData.reporter as Record<string, string>) ?? {};
    const vars = this.buildVars(ticketData, {
      status: 'REPORTADO',
      reporterName: reporter['name'] ?? '',
      reporterPhone: reporter['phone'] ?? '',
    });

    const tpl = config.templates.created;
    const subject = interpolate(tpl.subject, vars).replace(/\{link\}/g, '').trim();
    const html = this.wrapHtml(
      'Nuevo ticket creado',
      interpolate(tpl.body, vars),
      this.ticketUrl(ticketData),
    );

    await this.send(recipients, subject, html).catch((err) =>
      this.logger.error('Error enviando email de ticket creado', err),
    );
  }

  async notifyStatusChanged(
    ticketData: Record<string, unknown>,
    prevStatus: string,
    newStatus: string,
  ): Promise<void> {
    this.logger.log(`notifyStatusChanged: ticket=${ticketData.ticketNumber} ${prevStatus} → ${newStatus}`);
    const config = await this.getConfig();
    const assignedGestorIds = (ticketData.assignedGestorIds as string[]) ?? [];
    const adminEmails = (ticketData.notifyAdminEmails as string[]) ?? [];
    const recipients = await this.resolveRecipients(assignedGestorIds, adminEmails);
    if (!recipients.length) {
      this.logger.warn('notifyStatusChanged: sin destinatarios — email omitido');
      return;
    }

    const reporter = (ticketData.reporter as Record<string, string>) ?? {};
    const vars = this.buildVars(ticketData, {
      prevStatus,
      newStatus,
      reporterName: reporter['name'] ?? '',
      reporterPhone: reporter['phone'] ?? '',
    });

    const tpl = config.templates.statusChanged;
    const subject = interpolate(tpl.subject, vars).replace(/\{link\}/g, '').trim();
    const html = this.wrapHtml(
      'Cambio de estado en ticket',
      interpolate(tpl.body, vars),
      this.ticketUrl(ticketData),
    );

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

  /**
   * Builds the public URL of a ticket in the admin panel. Requires FRONTEND_URL
   * in the environment and the ticket's document id (`ticketData.id`). Opening it
   * asks the user to log in (the /admin layout is an auth gate). Returns null if
   * the URL can't be built (no base or no id), so the {link} button is omitted.
   */
  private ticketUrl(ticketData: Record<string, unknown>): string | null {
    const base = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
    const id = ticketData.id as string | undefined;
    if (!base || !id) return null;
    return `${base}/admin/dashboard/tickets/${id}`;
  }

  /**
   * Wraps the (plain-text, {var}-interpolated) body in the styled email layout.
   * The `{link}` placeholder is rendered as a clickable button that opens the
   * ticket directly (when `linkUrl` is available); otherwise it's removed.
   */
  private wrapHtml(title: string, body: string, linkUrl?: string | null): string {
    const button = linkUrl
      ? `<a href="${linkUrl}" style="display:inline-block;background:#1a1a2e;color:#fff;` +
        `text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:bold;` +
        `margin:4px 0">Ver ticket</a>`
      : '';

    // `{` y `}` no se escapan, asi que el marcador {link} sobrevive al escape.
    const escaped = escapeHtml(body).replace(/\n/g, '<br/>');
    const hasMarker = /\{link\}/.test(escaped);
    // Si el cuerpo trae {link}, el boton va en ese lugar; si no, y hay enlace, se
    // anade automaticamente al final para que el boton siempre aparezca.
    let bodyHtml = escaped.replace(/\{link\}/g, button);
    if (!hasMarker && button) {
      bodyHtml += `<div style="margin-top:20px">${button}</div>`;
    }

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
