import type { User } from "./models";

function _processUser(user: User) {
	user.address.save();
}
