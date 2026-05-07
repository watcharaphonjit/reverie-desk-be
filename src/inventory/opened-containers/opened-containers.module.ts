import { Module } from '@nestjs/common';
import { OpenedContainersController } from './opened-containers.controller';
import { OpenedContainersService } from './opened-containers.service';

@Module({
  controllers: [OpenedContainersController],
  providers: [OpenedContainersService],
  exports: [OpenedContainersService],
})
export class OpenedContainersModule {}
