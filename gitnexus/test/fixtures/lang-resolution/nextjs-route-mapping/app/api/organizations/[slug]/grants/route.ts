import { NextResponse } from "next/server";

export async function GET(
	_request: Request,
	{ params }: { params: { slug: string } },
) {
	const grants = await fetchOrgGrants(params.slug);
	return NextResponse.json({ data: grants });
}
