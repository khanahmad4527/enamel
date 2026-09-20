import { Module } from "@nestjs/common";
import { ImagingController } from "./imaging.controller";
import { DbModule } from "../db/db.module";
import { DirectusModule } from "../directus/directus.module";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [DbModule, DirectusModule, AuditModule],
  controllers: [ImagingController],
})
export class ImagingModule {}
