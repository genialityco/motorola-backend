import { Global, Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { BotConfigModule } from '../bot-config/bot-config.module';
import { UsersModule } from '../users/users.module';

// Infrastructure services
import { WhatsappMessagesService } from './_internal/whatsapp-messages.service';
import { WhatsappSessionService } from './_internal/whatsapp-session.service';
import { WhatsappFormattingService } from './_internal/whatsapp-formatting.service';
import { WhatsappMediaService } from './_internal/whatsapp-media.service';
import { WhatsappTicketsUtilService } from './_internal/whatsapp-tickets-util.service';
import { WhatsappTicketCreationService } from './_internal/whatsapp-ticket-creation.service';
import { WhatsappFieldUpdateService } from './_internal/whatsapp-field-update.service';

// Flow services
import { WhatsappCreateFlowService } from './_internal/flows/create-flow.service';
import { WhatsappViewFlowService } from './_internal/flows/view-flow.service';
import { WhatsappEditFlowService } from './_internal/flows/edit-flow.service';
import { WhatsappEditPhotosFlowService } from './_internal/flows/edit-photos-flow.service';
import { WhatsappDeleteFlowService } from './_internal/flows/delete-flow.service';
import { WhatsappMainFlowService } from './_internal/flows/main-flow.service';

// Orchestrator
import { WhatsappFlowOrchestratorService } from './_internal/whatsapp-flow-orchestrator.service';

@Global()
@Module({
  imports: [BotConfigModule, UsersModule],
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    WhatsappMessagesService,
    WhatsappSessionService,
    WhatsappFormattingService,
    WhatsappMediaService,
    WhatsappTicketsUtilService,
    WhatsappTicketCreationService,
    WhatsappFieldUpdateService,
    WhatsappCreateFlowService,
    WhatsappViewFlowService,
    WhatsappEditFlowService,
    WhatsappEditPhotosFlowService,
    WhatsappDeleteFlowService,
    WhatsappMainFlowService,
    WhatsappFlowOrchestratorService,
    FirebaseAuthGuard,
  ],
  exports: [WhatsappService],
})
export class WhatsappModule {}
