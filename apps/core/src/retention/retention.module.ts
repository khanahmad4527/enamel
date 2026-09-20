import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { DirectusModule } from "../directus/directus.module";
import { RetentionController } from "./retention.controller";
import { RetentionService } from "./retention.service";

@Module({
  imports: [DbModule, DirectusModule],
  controllers: [RetentionController],
  providers: [RetentionService],
})
export class RetentionModule {}
