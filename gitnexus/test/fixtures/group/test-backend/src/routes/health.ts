import { Router } from "express";

const router = Router();

router.get("/api/health", (_req, res) => {
	res.json({ status: "ok" });
});

export default router;
