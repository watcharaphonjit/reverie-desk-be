import { PartialType } from '@nestjs/mapped-types';
import { CreateLeadInteractionDto } from './create-lead-interaction.dto';

export class UpdateLeadInteractionDto extends PartialType(
  CreateLeadInteractionDto,
) {}
