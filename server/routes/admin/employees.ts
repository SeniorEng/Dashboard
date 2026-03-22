import { Router } from "express";
import userRoutes from "./employee-users";
import availabilityRoutes from "./employee-availability";

const router = Router();

router.use(userRoutes);
router.use(availabilityRoutes);

export default router;
