import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  Param,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { WhatsappService } from './whatsapp.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

type UploadedImage = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
};

@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  // Verificación del webhook por Meta (GET)
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const result = this.whatsappService.verifyWebhook(mode, token, challenge);
    if (result !== null) {
      res.status(200).send(result);
    } else {
      res.sendStatus(403);
    }
  }

  // Mensajes entrantes de Meta (POST) — responde 200 inmediatamente y procesa en background
  @Post('webhook')
  handleWebhook(@Body() body: any, @Res() res: Response) {
    if (body?.object) {
      res.status(200).send('EVENT_RECEIVED');
      this.whatsappService
        .processMessage(body)
        .catch((err) => console.error('Error procesando mensaje:', err));
      return;
    }
    res.sendStatus(404);
  }

  // Simulador: procesa el mensaje y devuelve las respuestas del bot directamente.
  // Acepta multipart/form-data con campos `phone`, `message` (opcional) y
  // `files` (0..N imágenes). Las imágenes se suben a Firebase Storage y se
  // inyectan como mensajes WhatsApp sintéticos con `directUrl`.
  @Post('simulate')
  @UseInterceptors(FilesInterceptor('files'))
  async simulate(
    @Body() body: { phone: string; message?: string },
    @UploadedFiles() files: UploadedImage[] = [],
    @Res() res: Response,
  ) {
    const responses: string[] = [];
    const photoUrls: string[] = [];
    const collect = (msg: string) => responses.push(msg);

    // 1. Subir cada imagen a Storage y procesarla como mensaje "image"
    for (const file of files) {
      const url = await this.whatsappService.uploadBufferToStorage(
        file.buffer,
        file.mimetype || 'image/jpeg',
        body.phone,
      );
      if (!url) continue;
      photoUrls.push(url);

      const imagePayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: body.phone,
                      type: 'image',
                      image: {
                        directUrl: url,
                        mime_type: file.mimetype || 'image/jpeg',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      await this.whatsappService.processMessage(imagePayload, collect);
    }

    // 2. Procesar el texto (si lo hay) — esto cierra la creación del ticket
    //    cuando el usuario está en el flujo WAITING_PHOTOS_AND_DESC.
    const text = body.message?.trim();
    if (text) {
      const textPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: body.phone,
                      type: 'text',
                      text: { body: text },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      await this.whatsappService.processMessage(textPayload, collect);
    }

    res.json({ responses, photoUrls });
  }

  // Admin: envía un mensaje manual a un usuario de WhatsApp
  @Post('send')
  @UseGuards(FirebaseAuthGuard)
  async sendAdminMessage(@Body() body: { to: string; message: string }) {
    await this.whatsappService.sendAdminMessage(body.to, body.message);
    return { success: true };
  }

  // Admin: solicita al usuario mejorar un campo del ticket por WhatsApp
  @Post('request-field-update')
  @UseGuards(FirebaseAuthGuard)
  async requestFieldUpdate(
    @Body() body: { ticketId: string; fieldKey: string; fieldLabel: string; customMessage?: string },
  ) {
    await this.whatsappService.requestFieldUpdate(body.ticketId, body.fieldKey, body.fieldLabel, body.customMessage);
    return { success: true };
  }

  // Admin: habilita o deshabilita las respuestas automáticas del bot
  @Post('bot-toggle')
  @UseGuards(FirebaseAuthGuard)
  async toggleBot(@Body() body: { phone: string; botEnabled: boolean }) {
    await this.whatsappService.toggleBotForSession(body.phone, body.botEnabled);
    return { success: true };
  }

  // Obtener historial de chat de un usuario
  @Get('chat-history/:phone')
  async getChatHistory(@Param('phone') phone: string) {
    const messages = await this.whatsappService.getChatHistory(phone);
    return { phone, messages };
  }

  // Enviar mensaje desde el admin (nuevo endpoint para la página de chats)
  @Post('send-message')
  @UseGuards(FirebaseAuthGuard)
  async sendMessage(@Body() body: { to: string; text: string }) {
    await this.whatsappService.sendAdminMessage(body.to, body.text);
    return { success: true, message: 'Mensaje enviado' };
  }
}
