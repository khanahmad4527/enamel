import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { DirectusModule } from "../directus/directus.module";
import { SubjectAccessController } from "./subject-access.controller";
import { SubjectAccessService } from "./subject-access.service";

@Module({
  imports: [AuditModule, DirectusModule],
  controllers: [SubjectAccessController],
  providers: [SubjectAccessService],
})
export class SubjectAccessModule {}
