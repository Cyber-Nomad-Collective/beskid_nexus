import { getUser } from "./service";

function _processUser() {
	const user = getUser("alice");
	user.save();
}

function _processAlias() {
	const user = getUser("bob");
	const alias = user;
	alias.save();
}
