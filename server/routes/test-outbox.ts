import { Router, type Request, type Response } from "express";
import { getTestOutbox, clearTestOutbox } from "../services/email-service";

const router = Router();

router.get("/outbox", (_req: Request, res: Response) => {
  res.json({ messages: getTestOutbox() });
});

router.delete("/outbox", (_req: Request, res: Response) => {
  clearTestOutbox();
  res.json({ success: true });
});

export default router;
