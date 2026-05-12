import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreditWalletDto } from './dto/credit-wallet.dto';
import { DebitWalletDto } from './dto/debit-wallet.dto';
import { TransferWalletDto } from './dto/transfer-wallet.dto';
import { WalletHistoryQueryDto } from './dto/wallet-history-query.dto';
import { WalletService } from './wallet.service';

const READ_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CS',
  'TELESALES',
] as const;
const WRITE_ROLES = [
  'ADMIN',
  'SUPER_BRANCH_MANAGER',
  'BRANCH_MANAGER',
  'CS',
] as const;

@ApiTags('wallet')
@ApiBearerAuth('bearer')
@Controller('wallet')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('customer/:customerId')
  listForCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId') customerId: string,
  ) {
    return this.wallet.listForCustomer(user, customerId);
  }

  @Get('history')
  listHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WalletHistoryQueryDto,
  ) {
    return this.wallet.listHistory(user, query);
  }

  @Post('credit')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  credit(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreditWalletDto) {
    return this.wallet.credit(user, dto);
  }

  @Post('debit')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  debit(@CurrentUser() user: AuthenticatedUser, @Body() dto: DebitWalletDto) {
    return this.wallet.debit(user, dto);
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @Roles(...WRITE_ROLES)
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TransferWalletDto,
  ) {
    return this.wallet.transfer(user, dto);
  }
}
