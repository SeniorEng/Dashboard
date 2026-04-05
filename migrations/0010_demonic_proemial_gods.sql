ALTER TABLE "customer_service_prices" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "insurance_providers_active_idx" ON "insurance_providers" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "doc_deliveries_customer_idx" ON "document_deliveries" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "doc_deliveries_document_idx" ON "document_deliveries" USING btree ("generated_document_id");--> statement-breakpoint
CREATE INDEX "doc_deliveries_status_idx" ON "document_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "whatsapp_log_user_idx" ON "whatsapp_message_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "whatsapp_log_created_idx" ON "whatsapp_message_log" USING btree ("created_at");