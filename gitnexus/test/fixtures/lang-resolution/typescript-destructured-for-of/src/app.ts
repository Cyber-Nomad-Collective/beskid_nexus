import type { User } from "./user";

function _processEntries(entries: Map<string, User>) {
	for (const [_key, user] of entries) {
		user.save();
	}
}
