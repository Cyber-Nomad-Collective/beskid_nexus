import { NextResponse } from "next/server";
import { withAuth } from "../../../middleware/auth";
import { withRateLimit } from "../../../middleware/rate-limit";

export const GET = withAuth(
	withRateLimit(async (_req: Request) => {
		return NextResponse.json({ items: [], count: 0 });
	}),
);

export const POST = async (req: Request) => {
	const _body = await req.json();
	return NextResponse.json({ id: "123", created: true });
};
