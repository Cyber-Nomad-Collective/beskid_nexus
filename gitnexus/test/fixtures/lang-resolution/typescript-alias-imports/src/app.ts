import { Repo as R, User as U } from "./models";

export function main() {
	const u = new U("alice");
	const r = new R("https://example.com");
	u.save();
	r.persist();
}
