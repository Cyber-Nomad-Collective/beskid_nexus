import { fetchUserAsync, getUser } from "./service";

function _processUser() {
	const user = getUser("alice");
	user.save();
}

async function _processUserAsync() {
	const user = await fetchUserAsync("bob");
	user.save();
}
