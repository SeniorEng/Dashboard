# WhatsApp-Versand (Twilio)

Detail zur WhatsApp-Integration. Übergeordneter Projekt-README: [`../replit.md`](../replit.md).

## WhatsApp-Provider = Twilio

Versand erfolgt ausschließlich über die Twilio WhatsApp Content API (`twilio` SDK, `client.messages.create({ contentSid, contentVariables })`). Die `templateName`-Spalte in `whatsapp_notification_rules` enthält Twilio Content SIDs (`HX…`), nicht mehr Meta-Template-Namen. Die DB-Spalten `whatsapp_phone_number_id` und `whatsapp_business_account_id` sind veraltet (durch Startup-Migration auf NULL gesetzt) und werden nicht mehr gelesen — bleiben aber zur Vermeidung destruktiver Drizzle-Push-Warnungen erhalten. `whatsapp_access_token` dient jetzt als optionaler Override für `TWILIO_AUTH_TOKEN`.
