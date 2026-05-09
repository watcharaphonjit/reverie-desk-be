import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreatePurchaseReceiptDto } from './dto/create-purchase-receipt.dto';
import { PurchaseReceiptQueryDto } from './dto/purchase-receipt-query.dto';
import { PurchaseReceiptsService } from './purchase-receipts.service';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
  'CS',
] as const;
const WRITE_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'CENTRAL_STOCK_HUB',
] as const;

@ApiTags('inventory-purchase-receipts')
@ApiBearerAuth('bearer')
@Controller('purchase-receipts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class PurchaseReceiptsController {
  constructor(private readonly receipts: PurchaseReceiptsService) {}

  @Post()
  @Roles(...WRITE_ROLES)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePurchaseReceiptDto,
  ) {
    return this.receipts.create(user, dto);
  }

  @Get()
  findAll(@Query() query: PurchaseReceiptQueryDto) {
    return this.receipts.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.receipts.findOne(id);
  }
}
